function emit(target, type, detail) {
  target.dispatchEvent(new CustomEvent(type, { detail }));
}

class WebBluetoothGattLink extends EventTarget {
  constructor({ device, characteristic, network }) {
    super();
    this.device = device;
    this.characteristic = characteristic;
    this.network = network;
    this.name = device.name || "Appareil BitChat";
    this.supportsMultiplePeers = false;
    this.peerCount = 1;
    this.fragmentDelayMilliseconds = 25;
    this.onCharacteristicValue = (event) => {
      const value = event.target?.value;
      if (!value) return;
      emit(this, "data", new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
    };
    this.onDisconnected = () => emit(this, "disconnect", null);
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected && this.characteristic);
  }

  get canTransmit() {
    return this.connected;
  }

  async start() {
    this.device.addEventListener("gattserverdisconnected", this.onDisconnected);
    this.characteristic.addEventListener("characteristicvaluechanged", this.onCharacteristicValue);
    await this.characteristic.startNotifications();
  }

  async write(bytes) {
    const properties = this.characteristic.properties;
    if (properties.writeWithoutResponse && this.characteristic.writeValueWithoutResponse) {
      await this.characteristic.writeValueWithoutResponse(bytes);
    } else if (properties.write && this.characteristic.writeValueWithResponse) {
      await this.characteristic.writeValueWithResponse(bytes);
    } else {
      await this.characteristic.writeValue(bytes);
    }
  }

  close() {
    this.characteristic?.removeEventListener("characteristicvaluechanged", this.onCharacteristicValue);
    this.device?.removeEventListener("gattserverdisconnected", this.onDisconnected);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
}

export class WebBluetoothCentralConnector {
  static get isSupported() {
    return Boolean(globalThis.navigator?.bluetooth);
  }

  async connect({ preferredNetwork, networks, characteristicUUID }) {
    const serviceUUIDs = Object.values(networks).map((entry) => entry.serviceUUID);
    const device = await navigator.bluetooth.requestDevice({
      filters: serviceUUIDs.map((serviceUUID) => ({ services: [serviceUUID] })),
      optionalServices: serviceUUIDs
    });
    const server = await device.gatt.connect();
    let service;
    try {
      service = await server.getPrimaryService(preferredNetwork.serviceUUID);
    } catch {
      const services = await server.getPrimaryServices();
      service = services.find((candidate) => serviceUUIDs.includes(candidate.uuid));
    }
    if (!service) throw new Error("Le service BitChat n’est pas exposé par cet appareil");
    const network = Object.values(networks).find((entry) => entry.serviceUUID === service.uuid)
      ?? preferredNetwork;
    const characteristic = await service.getCharacteristic(characteristicUUID);
    return new WebBluetoothGattLink({ device, characteristic, network });
  }
}

class WindowsNativeGattLink extends EventTarget {
  constructor({ api, network }) {
    super();
    this.api = api;
    this.network = network;
    this.name = "Nœud mesh Windows";
    this.connected = true;
    this.supportsMultiplePeers = true;
    this.peerCount = 0;
    this.fragmentDelayMilliseconds = 3;
    this.unsubscribe = api.onEvent((event) => {
      if (event.event === "data") {
        const binary = atob(event.data);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        emit(this, "data", bytes);
      } else if (event.event === "subscribers") {
        this.peerCount = Math.max(0, Number(event.count) || 0);
        emit(this, "subscriberchange", { count: this.peerCount });
      } else if (event.event === "status" && ["Stopped", "Aborted"].includes(event.status)) {
        this.connected = false;
        emit(this, "disconnect", null);
      } else if (event.event === "error") {
        emit(this, "error", new Error(event.error));
      }
    });
  }

  async start() {}

  get canTransmit() {
    return this.connected && this.peerCount > 0;
  }

  async write(bytes) {
    if (!this.canTransmit) throw new Error("Aucun téléphone BitChat n’est connecté au service Bluetooth Windows");
    const result = await this.api.write(bytes);
    if (!result?.clients || !result?.chunks) {
      throw new Error("Le téléphone BitChat n’est plus abonné au service Bluetooth Windows");
    }
    return result;
  }

  close() {
    this.connected = false;
    this.peerCount = 0;
    this.unsubscribe?.();
    void this.api.stop();
  }
}

export class WindowsNativePeripheralConnector {
  static get isSupported() {
    return Boolean(globalThis.bitchatDesktopRadio);
  }

  async connect({ preferredNetwork }) {
    const result = await globalThis.bitchatDesktopRadio.start(preferredNetwork.id);
    return new WindowsNativeGattLink({
      api: globalThis.bitchatDesktopRadio,
      network: { ...preferredNetwork, id: result.network ?? preferredNetwork.id }
    });
  }
}

export function createDefaultBLEConnector() {
  if (WindowsNativePeripheralConnector.isSupported) return new WindowsNativePeripheralConnector();
  if (WebBluetoothCentralConnector.isSupported) return new WebBluetoothCentralConnector();
  return null;
}

export function isDefaultBLEConnectorSupported() {
  return WindowsNativePeripheralConnector.isSupported || WebBluetoothCentralConnector.isSupported;
}
