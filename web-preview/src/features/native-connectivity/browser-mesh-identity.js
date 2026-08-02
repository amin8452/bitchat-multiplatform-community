import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "../../core/bytes.js";
import { peerIDFromNoisePublicKey } from "./bit-chat-codec.js";

const STORAGE_KEY = "bitchat-web-native-identity-v1";

function base64ToBytes(value) {
  const binary = atob(String(value ?? ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function loadMeshIdentity({
  desktopIdentity = globalThis.bitchatDesktopIdentity,
  storage = globalThis.sessionStorage,
  storageKey = STORAGE_KEY
} = {}) {
  if (!desktopIdentity?.loadOrCreate) {
    return BrowserMeshIdentity.load(storage, storageKey);
  }
  const protectedIdentity = await desktopIdentity.loadOrCreate();
  if (protectedIdentity?.scheme !== "dpapi-current-user-v1") {
    throw new Error("Unsupported Desktop identity protection scheme");
  }
  const noiseSecretKey = base64ToBytes(protectedIdentity.noiseSecretKey);
  const signingSecretKey = base64ToBytes(protectedIdentity.signingSecretKey);
  if (noiseSecretKey.length !== 32 || signingSecretKey.length !== 32) {
    throw new Error("Invalid protected Desktop identity");
  }
  return new BrowserMeshIdentity({ noiseSecretKey, signingSecretKey });
}

export class BrowserMeshIdentity {
  static load(storage = globalThis.sessionStorage, storageKey = STORAGE_KEY) {
    const saved = storage?.getItem(storageKey);
    if (saved) {
      try {
        const value = JSON.parse(saved);
        const noiseSecretKey = hexToBytes(value.noiseSecretKey);
        const signingSecretKey = hexToBytes(value.signingSecretKey);
        if (noiseSecretKey?.length === 32 && signingSecretKey?.length === 32) {
          return new BrowserMeshIdentity({
            noiseSecretKey,
            signingSecretKey,
            storage,
            storageKey
          });
        }
      } catch {
        // A corrupted browser-only identity is replaced below.
      }
    }
    return new BrowserMeshIdentity({
      noiseSecretKey: x25519.utils.randomSecretKey(),
      signingSecretKey: ed25519.utils.randomSecretKey(),
      storage,
      storageKey
    });
  }

  constructor({
    noiseSecretKey,
    signingSecretKey,
    storage = null,
    storageKey = STORAGE_KEY
  }) {
    this.noiseSecretKey = noiseSecretKey.slice();
    this.signingSecretKey = signingSecretKey.slice();
    this.noisePublicKey = x25519.getPublicKey(this.noiseSecretKey);
    this.signingPublicKey = ed25519.getPublicKey(this.signingSecretKey);
    this.peerID = peerIDFromNoisePublicKey(this.noisePublicKey);
    storage?.setItem(storageKey, JSON.stringify({
      noiseSecretKey: bytesToHex(this.noiseSecretKey),
      signingSecretKey: bytesToHex(this.signingSecretKey)
    }));
  }

  get peerIDHex() {
    return bytesToHex(this.peerID);
  }
}
