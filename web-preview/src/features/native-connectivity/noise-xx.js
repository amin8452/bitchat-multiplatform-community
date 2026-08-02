import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { BitChatWireContract } from "./wire-contract.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import {
  concatBytes,
  equalBytes,
  randomBytes,
  utf8ToBytes,
  writeUint64LE
} from "../../core/bytes.js";

export const NoiseProtocolName = BitChatWireContract.noise.protocolName;

function noiseHKDF(chainingKey, inputKeyMaterial, count) {
  const temporaryKey = hmac(sha256, chainingKey, inputKeyMaterial);
  const outputs = [];
  let previous = new Uint8Array();
  for (let index = 1; index <= count; index += 1) {
    previous = hmac(sha256, temporaryKey, concatBytes(previous, Uint8Array.of(index)));
    outputs.push(previous);
  }
  return outputs;
}

function noiseNonce(counter) {
  return concatBytes(new Uint8Array(4), writeUint64LE(counter));
}

class NoiseCipherState {
  constructor(key = null, { extractedNonce = false } = {}) {
    this.key = key;
    this.nonce = 0n;
    this.extractedNonce = extractedNonce;
    this.highestReceivedNonce = -1n;
    this.receivedNonces = new Set();
  }

  initializeKey(key) {
    this.key = key.slice();
    this.nonce = 0n;
  }

  hasKey() {
    return Boolean(this.key);
  }

  encrypt(plaintext, associatedData = new Uint8Array()) {
    if (!this.key) throw new Error("Noise cipher is not initialized");
    if (this.nonce > 0xfffffffen) throw new Error("Noise transport nonce exhausted");
    const currentNonce = this.nonce;
    const ciphertext = chacha20poly1305(
      this.key,
      noiseNonce(currentNonce),
      associatedData
    ).encrypt(plaintext);
    this.nonce += 1n;
    if (!this.extractedNonce) return ciphertext;

    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, Number(currentNonce), false);
    return concatBytes(prefix, ciphertext);
  }

  decrypt(input, associatedData = new Uint8Array()) {
    if (!this.key) throw new Error("Noise cipher is not initialized");
    let ciphertext = input;
    let currentNonce = this.nonce;

    if (this.extractedNonce) {
      if (input.length < 20) throw new Error("Invalid Noise transport ciphertext");
      currentNonce = BigInt(new DataView(input.buffer, input.byteOffset, 4).getUint32(0, false));
      if (!this.#canAcceptNonce(currentNonce)) throw new Error("Noise replay detected");
      ciphertext = input.slice(4);
    } else if (input.length < 16) {
      throw new Error("Invalid Noise handshake ciphertext");
    }

    const plaintext = chacha20poly1305(
      this.key,
      noiseNonce(currentNonce),
      associatedData
    ).decrypt(ciphertext);
    if (this.extractedNonce) this.#recordNonce(currentNonce);
    this.nonce += 1n;
    return plaintext;
  }

  #canAcceptNonce(nonce) {
    if (this.receivedNonces.has(nonce.toString())) return false;
    return this.highestReceivedNonce < 1024n || nonce > this.highestReceivedNonce - 1024n;
  }

  #recordNonce(nonce) {
    if (nonce > this.highestReceivedNonce) this.highestReceivedNonce = nonce;
    this.receivedNonces.add(nonce.toString());
    const minimum = this.highestReceivedNonce - 1024n;
    for (const value of this.receivedNonces) {
      if (BigInt(value) <= minimum) this.receivedNonces.delete(value);
    }
  }
}

class NoiseSymmetricState {
  constructor(protocolName = NoiseProtocolName) {
    const name = utf8ToBytes(protocolName);
    this.hash = name.length <= 32
      ? concatBytes(name, new Uint8Array(32 - name.length))
      : sha256(name);
    this.chainingKey = this.hash.slice();
    this.cipher = new NoiseCipherState();
  }

  mixHash(data) {
    this.hash = sha256(concatBytes(this.hash, data));
  }

  mixKey(inputKeyMaterial) {
    const [chainingKey, temporaryKey] = noiseHKDF(this.chainingKey, inputKeyMaterial, 2);
    this.chainingKey = chainingKey;
    this.cipher.initializeKey(temporaryKey);
  }

  encryptAndHash(plaintext) {
    const ciphertext = this.cipher.hasKey()
      ? this.cipher.encrypt(plaintext, this.hash)
      : plaintext;
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext) {
    const plaintext = this.cipher.hasKey()
      ? this.cipher.decrypt(ciphertext, this.hash)
      : ciphertext;
    this.mixHash(ciphertext);
    return plaintext;
  }

  split({ extractedNonce }) {
    const [first, second] = noiseHKDF(this.chainingKey, new Uint8Array(), 2);
    return [
      new NoiseCipherState(first, { extractedNonce }),
      new NoiseCipherState(second, { extractedNonce })
    ];
  }
}

const XX_PATTERN = [
  ["e"],
  ["e", "ee", "s", "es"],
  ["s", "se"]
];

export class NoiseXXHandshake {
  constructor({
    role,
    localStaticSecret,
    prologue = new Uint8Array(),
    ephemeralSecret = null
  }) {
    if (!["initiator", "responder"].includes(role)) throw new Error("Invalid Noise role");
    if (localStaticSecret?.length !== 32) throw new Error("Noise static key must contain 32 bytes");
    this.role = role;
    this.localStaticSecret = localStaticSecret.slice();
    this.localStaticPublic = x25519.getPublicKey(this.localStaticSecret);
    this.localEphemeralSecret = null;
    this.localEphemeralPublic = null;
    this.remoteStaticPublic = null;
    this.remoteEphemeralPublic = null;
    this.predeterminedEphemeralSecret = ephemeralSecret?.slice() ?? null;
    this.symmetric = new NoiseSymmetricState();
    this.symmetric.mixHash(prologue);
    this.patternIndex = 0;
  }

  writeMessage(payload = new Uint8Array()) {
    if (this.isComplete()) throw new Error("Noise handshake is complete");
    const output = [];
    for (const token of XX_PATTERN[this.patternIndex]) {
      switch (token) {
        case "e":
          this.localEphemeralSecret = this.predeterminedEphemeralSecret ?? x25519.utils.randomSecretKey();
          this.predeterminedEphemeralSecret = null;
          this.localEphemeralPublic = x25519.getPublicKey(this.localEphemeralSecret);
          output.push(this.localEphemeralPublic);
          this.symmetric.mixHash(this.localEphemeralPublic);
          break;
        case "s":
          output.push(this.symmetric.encryptAndHash(this.localStaticPublic));
          break;
        default:
          this.#performDH(token);
      }
    }
    output.push(this.symmetric.encryptAndHash(payload));
    this.patternIndex += 1;
    return concatBytes(...output);
  }

  readMessage(message) {
    if (this.isComplete()) throw new Error("Noise handshake is complete");
    let offset = 0;
    for (const token of XX_PATTERN[this.patternIndex]) {
      switch (token) {
        case "e": {
          if (offset + 32 > message.length) throw new Error("Invalid Noise ephemeral key");
          this.remoteEphemeralPublic = message.slice(offset, offset + 32);
          this.#validatePublicKey(this.remoteEphemeralPublic);
          offset += 32;
          this.symmetric.mixHash(this.remoteEphemeralPublic);
          break;
        }
        case "s": {
          const length = this.symmetric.cipher.hasKey() ? 48 : 32;
          if (offset + length > message.length) throw new Error("Invalid Noise static key");
          const encrypted = message.slice(offset, offset + length);
          offset += length;
          this.remoteStaticPublic = this.symmetric.decryptAndHash(encrypted);
          this.#validatePublicKey(this.remoteStaticPublic);
          break;
        }
        default:
          this.#performDH(token);
      }
    }
    const payload = this.symmetric.decryptAndHash(message.slice(offset));
    this.patternIndex += 1;
    return payload;
  }

  isComplete() {
    return this.patternIndex >= XX_PATTERN.length;
  }

  transportCiphers({ extractedNonce = true } = {}) {
    if (!this.isComplete()) throw new Error("Noise handshake is not complete");
    const handshakeHash = this.symmetric.hash.slice();
    const [first, second] = this.symmetric.split({ extractedNonce });
    return this.role === "initiator"
      ? { send: first, receive: second, handshakeHash }
      : { send: second, receive: first, handshakeHash };
  }

  #performDH(token) {
    let localSecret;
    let remotePublic;
    if (token === "ee") {
      [localSecret, remotePublic] = [this.localEphemeralSecret, this.remoteEphemeralPublic];
    } else if (token === "es" && this.role === "initiator") {
      [localSecret, remotePublic] = [this.localEphemeralSecret, this.remoteStaticPublic];
    } else if (token === "es") {
      [localSecret, remotePublic] = [this.localStaticSecret, this.remoteEphemeralPublic];
    } else if (token === "se" && this.role === "initiator") {
      [localSecret, remotePublic] = [this.localStaticSecret, this.remoteEphemeralPublic];
    } else if (token === "se") {
      [localSecret, remotePublic] = [this.localEphemeralSecret, this.remoteStaticPublic];
    }
    if (!localSecret || !remotePublic) throw new Error(`Missing Noise keys for ${token}`);
    this.symmetric.mixKey(x25519.getSharedSecret(localSecret, remotePublic));
  }

  #validatePublicKey(publicKey) {
    if (publicKey.length !== 32 || publicKey.every((byte) => byte === 0)) {
      throw new Error("Invalid Noise public key");
    }
  }
}

export class NoiseXXSession {
  constructor({ role, localStaticSecret }) {
    this.role = role;
    this.localStaticSecret = localStaticSecret;
    this.handshake = null;
    this.sendCipher = null;
    this.receiveCipher = null;
  }

  get state() {
    if (this.sendCipher && this.receiveCipher) return "established";
    if (this.handshake) return "handshaking";
    return "uninitialized";
  }

  start() {
    if (this.state !== "uninitialized" || this.role !== "initiator") {
      throw new Error("Noise session cannot start in its current state");
    }
    this.handshake = new NoiseXXHandshake({
      role: this.role,
      localStaticSecret: this.localStaticSecret
    });
    return this.handshake.writeMessage();
  }

  process(message) {
    if (!this.handshake) {
      if (this.role !== "responder") throw new Error("Noise initiator has not started");
      this.handshake = new NoiseXXHandshake({
        role: this.role,
        localStaticSecret: this.localStaticSecret
      });
    }
    this.handshake.readMessage(message);
    if (this.handshake.isComplete()) {
      this.#finishHandshake();
      return null;
    }
    const response = this.handshake.writeMessage();
    if (this.handshake.isComplete()) this.#finishHandshake();
    return response;
  }

  encrypt(plaintext) {
    if (!this.sendCipher) throw new Error("Noise session is not established");
    return this.sendCipher.encrypt(plaintext);
  }

  decrypt(ciphertext) {
    if (!this.receiveCipher) throw new Error("Noise session is not established");
    return this.receiveCipher.decrypt(ciphertext);
  }

  #finishHandshake() {
    const handshake = this.handshake;
    const ciphers = handshake.transportCiphers({ extractedNonce: true });
    this.sendCipher = ciphers.send;
    this.receiveCipher = ciphers.receive;
    this.remoteStaticPublic = handshake.remoteStaticPublic?.slice() ?? null;
    this.handshakeHash = ciphers.handshakeHash;
    this.handshake = null;
  }
}

export function areNoiseKeysEqual(left, right) {
  return equalBytes(left, right);
}
