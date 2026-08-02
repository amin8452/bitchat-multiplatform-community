const path = require("node:path");
const os = require("node:os");
const { mkdtemp, rm } = require("node:fs/promises");
const contract = require(path.join(__dirname, "..", "runtime", "protocol", "bitchat-wire-v1.json"));
const { WindowsBleRadioHost } = require("../src/windows-ble-radio-host.cjs");

async function main() {
  const identityRoot = await mkdtemp(path.join(os.tmpdir(), "bitchat-identity-smoke-"));
  const host = new WindowsBleRadioHost({
    executable: process.env.BITCHAT_RADIO_EXECUTABLE
      || path.join(__dirname, "..", "runtime", "native-windows", "bitchat-windows-radio.exe")
  });
  try {
    const identityPath = path.join(identityRoot, "identity.dpapi");
    const firstIdentity = await host.command("identity.loadOrCreate", { path: identityPath });
    const secondIdentity = await host.command("identity.loadOrCreate", { path: identityPath });
    if (firstIdentity.noiseSecretKey !== secondIdentity.noiseSecretKey
      || firstIdentity.signingSecretKey !== secondIdentity.signingSecretKey) {
      throw new Error("Protected Windows identity is not stable");
    }
    const networks = {};
    for (const [name, serviceUuid] of Object.entries({
      mainnet: contract.bluetooth.mainnetServiceUuid,
      testnet: contract.bluetooth.testnetServiceUuid
    })) {
      const started = await host.command("start", {
        serviceUuid,
        characteristicUuid: contract.bluetooth.characteristicUuid
      });
      if (started.advertising !== "Started") {
        throw new Error(`Native BLE ${name} advertising is not active`);
      }
      const notification = await host.command("write", {
        data: Buffer.from(`bitchat-radio-smoke-test:${name}`, "utf8").toString("base64")
      });
      networks[name] = { started, notification };
      await host.command("stop");
    }
    console.log(JSON.stringify({
      networks,
      identityProtection: firstIdentity.scheme
    }));
  } finally {
    await host.stop();
    await rm(identityRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
