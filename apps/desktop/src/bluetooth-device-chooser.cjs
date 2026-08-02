class BluetoothDeviceChooser {
  constructor({ dialog, scanDelay = 1800 }) {
    this.dialog = dialog;
    this.scanDelay = scanDelay;
    this.devices = new Map();
    this.callback = null;
    this.timer = null;
  }

  handle = (window, event, deviceList, callback) => {
    event.preventDefault();
    if (this.callback && this.callback !== callback) this.#finish("");
    this.callback = callback;
    for (const device of deviceList) this.devices.set(device.deviceId, device);
    if (!this.timer) this.timer = setTimeout(() => this.#prompt(window), this.scanDelay);
  };

  cancel() {
    this.#finish("");
  }

  async #prompt(window) {
    this.timer = null;
    const devices = [...this.devices.values()].slice(0, 8);
    if (!devices.length) {
      await this.dialog.showMessageBox(window, {
        type: "info",
        title: "Bluetooth BitChat",
        message: "Aucun appareil BitChat détecté.",
        detail: "Vérifiez que Bluetooth est activé et que le téléphone est à proximité.",
        buttons: ["Fermer"]
      });
      this.#finish("");
      return;
    }

    const labels = devices.map((device) => device.deviceName || `Appareil ${device.deviceId.slice(-6)}`);
    const cancelId = labels.length;
    const result = await this.dialog.showMessageBox(window, {
      type: "question",
      title: "Bluetooth BitChat",
      message: "Choisissez un appareil BitChat",
      buttons: [...labels, "Annuler"],
      cancelId,
      defaultId: 0,
      noLink: true
    });
    this.#finish(result.response === cancelId ? "" : devices[result.response]?.deviceId ?? "");
  }

  #finish(deviceId) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const callback = this.callback;
    this.callback = null;
    this.devices.clear();
    callback?.(deviceId);
  }
}

module.exports = { BluetoothDeviceChooser };
