import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BluetoothDeviceChooser } = require("../src/bluetooth-device-chooser.cjs");
const { reserveLocalPort } = require("../src/preview-runtime.cjs");

test("the desktop runtime can reserve a loopback port", async () => {
  const port = await reserveLocalPort();
  assert.ok(Number.isInteger(port));
  assert.ok(port > 0 && port <= 65535);
});

test("Bluetooth selection is explicit and does not auto-pick a device", async () => {
  let selected;
  let prevented = false;
  const chooser = new BluetoothDeviceChooser({
    scanDelay: 1,
    dialog: {
      async showMessageBox(_window, options) {
        assert.deepEqual(options.buttons, ["Téléphone", "Annuler"]);
        return { response: 0 };
      }
    }
  });
  chooser.handle({}, { preventDefault: () => { prevented = true; } }, [
    { deviceId: "phone-1", deviceName: "Téléphone" }
  ], (deviceId) => { selected = deviceId; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prevented, true);
  assert.equal(selected, "phone-1");
});

test("generated runtime contains the server, core and bundled UI", async () => {
  const root = new URL("../runtime/web-preview/", import.meta.url);
  await Promise.all([
    access(new URL("server.mjs", root)),
    access(new URL("src/core/index.js", root)),
    access(new URL("src/adapters/json-message-repository.js", root)),
    access(new URL("dist/app.js", root))
  ]);
  const server = await readFile(new URL("server.mjs", root), "utf8");
  assert.match(server, /from "\.\/src\/core\/index\.js"/);
});

test("generated desktop assets contain the native radio and shared contract", async () => {
  await Promise.all([
    access(new URL("../runtime/native-windows/bitchat-windows-radio.exe", import.meta.url)),
    access(new URL("../runtime/protocol/bitchat-wire-v1.json", import.meta.url)),
    access(new URL("../preload.cjs", import.meta.url))
  ]);
});

test("packaged diagnostics use Electron's stable command-line switch boundary", async () => {
  const main = await readFile(new URL("../main.cjs", import.meta.url), "utf8");
  assert.match(main, /app\.commandLine\.hasSwitch\("smoke-test"\)/);
  assert.match(main, /process\.env\.BITCHAT_DESKTOP_SMOKE_TEST === "1"/);
  assert.match(main, /identityProtection: identity\.scheme/);
});

test("window shutdown never dereferences destroyed Electron objects", async () => {
  const main = await readFile(new URL("../main.cjs", import.meta.url), "utf8");
  const closedHandler = main.match(/window\.on\("closed", \(\) => \{[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(closedHandler);
  assert.match(main, /const webContentsID = window\.webContents\.id;/);
  assert.match(closedHandler, /radioOwner === webContentsID/);
  assert.doesNotMatch(closedHandler, /window\.webContents/);
  assert.match(main, /!window\.isDestroyed\(\)[\s\S]*!window\.webContents\.isDestroyed\(\)/);
});
