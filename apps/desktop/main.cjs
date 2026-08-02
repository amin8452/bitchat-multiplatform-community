const path = require("node:path");
const { writeFileSync } = require("node:fs");
const { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } = require("electron");
const { BluetoothDeviceChooser } = require("./src/bluetooth-device-chooser.cjs");
const { PreviewRuntime } = require("./src/preview-runtime.cjs");
const { WindowsBleRadioHost } = require("./src/windows-ble-radio-host.cjs");

let runtime;
let appOrigin;
let permissionsConfigured = false;
let radioHost;
let radioOwner = null;
const windows = new Set();
// Packaged Electron consumes Chromium-style switches before exposing argv on
// some Windows launches. app.commandLine is the stable boundary for switches.
const isSmokeTest = app.commandLine.hasSwitch("smoke-test")
  || process.env.BITCHAT_DESKTOP_SMOKE_TEST === "1"
  || process.argv.includes("--smoke-test");

function writeSmokeReport(report) {
  if (!isSmokeTest) return;
  writeFileSync(
    path.join(app.getPath("temp"), "bitchat-desktop-smoke.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
}

function isAppURL(rawURL) {
  try {
    return new URL(rawURL).origin === appOrigin;
  } catch {
    return false;
  }
}

function assertTrustedRenderer(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  const senderURL = event.senderFrame?.url || event.sender.getURL();
  if (!window || !windows.has(window) || !isAppURL(senderURL)) {
    throw new Error("Untrusted Desktop IPC sender");
  }
}

function liveWindowByWebContentsID(id) {
  return [...windows].find((window) => (
    !window.isDestroyed()
    && !window.webContents.isDestroyed()
    && window.webContents.id === id
  ));
}

function configurePermissions(window) {
  if (permissionsConfigured) return;
  permissionsConfigured = true;
  const session = window.webContents.session;
  const allowed = new Set(["bluetooth", "media", "notifications"]);
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) => (
    windows.has(BrowserWindow.fromWebContents(contents))
    && allowed.has(permission)
    && isAppURL(requestingOrigin)
  ));
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      windows.has(BrowserWindow.fromWebContents(contents))
      && allowed.has(permission)
      && isAppURL(details.requestingUrl)
    );
  });
}

function createWindow(targetURL = `${appOrigin}/`) {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 580,
    backgroundColor: "#080b12",
    show: false,
    title: "BitChat Desktop",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true
    }
  });
  const webContentsID = window.webContents.id;
  const chooser = new BluetoothDeviceChooser({ dialog });
  windows.add(window);
  configurePermissions(window);

  window.webContents.on("select-bluetooth-device", (event, devices, callback) => {
    chooser.handle(window, event, devices, callback);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppURL(url)) createWindow(url);
    else if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppURL(url)) event.preventDefault();
  });
  window.on("closed", () => {
    windows.delete(window);
    chooser.cancel();
    if (radioOwner === webContentsID) {
      radioOwner = null;
      void radioHost?.command("stop").catch(() => {});
    }
  });
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  void window.loadURL(targetURL);
  return window;
}

async function startApplication() {
  const webRoot = app.isPackaged
    ? path.join(process.resourcesPath, "web-preview")
    : path.join(__dirname, "runtime", "web-preview");
  const contract = require(path.join(__dirname, "runtime", "protocol", "bitchat-wire-v1.json"));
  const nativeRadioRoot = app.isPackaged
    ? path.join(process.resourcesPath, "native-windows")
    : path.join(__dirname, "runtime", "native-windows");
  radioHost = new WindowsBleRadioHost({
    executable: path.join(nativeRadioRoot, "bitchat-windows-radio.exe")
  });
  radioHost.on("event", (event) => {
    const owner = liveWindowByWebContentsID(radioOwner);
    owner?.webContents.send("bitchat-radio:event", event);
  });
  ipcMain.handle("bitchat-radio:start", async (event, network) => {
    assertTrustedRenderer(event);
    if (radioOwner && radioOwner !== event.sender.id) {
      throw new Error("La radio Bluetooth native est déjà utilisée par une autre fenêtre.");
    }
    const serviceUuid = network === "testnet"
      ? contract.bluetooth.testnetServiceUuid
      : contract.bluetooth.mainnetServiceUuid;
    radioOwner = event.sender.id;
    try {
      const result = await radioHost.command("start", {
        serviceUuid,
        characteristicUuid: contract.bluetooth.characteristicUuid
      });
      return { ...result, network: network === "testnet" ? "testnet" : "mainnet" };
    } catch (error) {
      radioOwner = null;
      throw error;
    }
  });
  ipcMain.handle("bitchat-radio:write", async (event, data) => {
    assertTrustedRenderer(event);
    if (radioOwner !== event.sender.id) throw new Error("Cette fenêtre ne contrôle pas la radio Bluetooth.");
    const bytes = Buffer.from(data);
    if (!bytes.length || bytes.length > 1_000_000) throw new Error("Trame Bluetooth invalide.");
    return radioHost.command("write", { data: bytes.toString("base64") });
  });
  ipcMain.handle("bitchat-radio:stop", async (event) => {
    assertTrustedRenderer(event);
    if (radioOwner !== event.sender.id) return { stopped: true };
    radioOwner = null;
    return radioHost.command("stop");
  });
  ipcMain.handle("bitchat-identity:load-or-create", async (event) => {
    assertTrustedRenderer(event);
    return radioHost.command("identity.loadOrCreate", {
      path: path.join(app.getPath("userData"), "mesh-identity.dpapi")
    });
  });
  runtime = new PreviewRuntime({
    utilityProcess,
    webRoot,
    stateFile: path.join(app.getPath("userData"), "state.json")
  });
  appOrigin = await runtime.start();
  if (isSmokeTest) {
    const identity = await radioHost.command("identity.loadOrCreate", {
      path: path.join(app.getPath("userData"), "mesh-identity.dpapi")
    });
    const advertising = {};
    for (const [network, serviceUuid] of Object.entries({
      mainnet: contract.bluetooth.mainnetServiceUuid,
      testnet: contract.bluetooth.testnetServiceUuid
    })) {
      const started = await radioHost.command("start", {
        serviceUuid,
        characteristicUuid: contract.bluetooth.characteristicUuid
      });
      if (started.advertising !== "Started") {
        throw new Error(`Windows BLE ${network} advertising did not start`);
      }
      await radioHost.command("write", {
        data: Buffer.from(`bitchat-desktop-smoke-test:${network}`, "utf8").toString("base64")
      });
      advertising[network] = started;
      await radioHost.command("stop");
    }
    writeSmokeReport({
      ok: true,
      runtime: appOrigin,
      advertising: advertising.mainnet.advertising,
      networks: advertising,
      identityProtection: identity.scheme
    });
    app.quit();
    return;
  }
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = [...windows][0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.whenReady()
    .then(startApplication)
    .catch((error) => {
      writeSmokeReport({ ok: false, error: error?.stack ?? String(error) });
      if (isSmokeTest) console.error(error?.stack ?? String(error));
      else dialog.showErrorBox("BitChat Desktop", error?.stack ?? String(error));
      app.exit(1);
    });
}

app.on("activate", () => {
  if (appOrigin && windows.size === 0) createWindow();
});
app.on("before-quit", () => {
  runtime?.stop();
  radioHost?.terminate();
});
app.on("window-all-closed", () => app.quit());
