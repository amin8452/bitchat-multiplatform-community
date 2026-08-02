import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  base64URLToBytes,
  bytesToBase64URL,
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes
} from "../../core/bytes.js";
import { BitChatNoisePayloadType } from "./bit-chat-codec.js";

const QR_CONTEXT = "bitchat-verify-v1";
const RESPONSE_CONTEXT = "bitchat-verify-resp-v1";

export const VerificationQRMaximumAgeSeconds = 300;

function appendCanonicalField(parts, value) {
  const bytes = utf8ToBytes(value);
  const length = Math.min(bytes.length, 255);
  parts.push(Uint8Array.of(length), bytes.slice(0, length));
}

function canonicalQRBytes(payload) {
  const parts = [];
  appendCanonicalField(parts, QR_CONTEXT);
  appendCanonicalField(parts, String(payload.v));
  appendCanonicalField(parts, payload.noiseKeyHex.toLowerCase());
  appendCanonicalField(parts, payload.signKeyHex.toLowerCase());
  appendCanonicalField(parts, payload.npub ?? "");
  appendCanonicalField(parts, payload.nickname);
  appendCanonicalField(parts, String(payload.ts));
  appendCanonicalField(parts, payload.nonceB64);
  return concatBytes(...parts);
}

function isHex(value, bytes) {
  return typeof value === "string"
    && value.length === bytes * 2
    && /^[0-9a-f]+$/i.test(value);
}

function qrURL(payload) {
  const url = new URL("bitchat://verify");
  url.searchParams.set("v", String(payload.v));
  url.searchParams.set("noise", payload.noiseKeyHex);
  url.searchParams.set("sign", payload.signKeyHex);
  url.searchParams.set("nick", payload.nickname);
  url.searchParams.set("ts", String(payload.ts));
  url.searchParams.set("nonce", payload.nonceB64);
  url.searchParams.set("sig", payload.sigHex);
  if (payload.npub) url.searchParams.set("npub", payload.npub);
  return url.toString();
}

export function buildVerificationQR({
  identity,
  nickname,
  npub = null,
  timestampSeconds = Math.floor(Date.now() / 1_000),
  nonce = randomBytes(16)
}) {
  if (identity?.noisePublicKey?.length !== 32
    || identity?.signingPublicKey?.length !== 32
    || identity?.signingSecretKey?.length !== 32) {
    throw new Error("Identité BitChat indisponible pour le QR");
  }
  if (!(nonce instanceof Uint8Array) || nonce.length !== 16) {
    throw new Error("Nonce QR BitChat invalide");
  }
  const payload = {
    v: 1,
    noiseKeyHex: bytesToHex(identity.noisePublicKey),
    signKeyHex: bytesToHex(identity.signingPublicKey),
    npub: npub || null,
    nickname: String(nickname ?? ""),
    ts: Number(timestampSeconds),
    nonceB64: bytesToBase64URL(nonce),
    sigHex: ""
  };
  const signature = ed25519.sign(canonicalQRBytes(payload), identity.signingSecretKey);
  payload.sigHex = bytesToHex(signature);
  return qrURL(payload);
}

export function parseAndVerifyVerificationQR(
  value,
  {
    nowSeconds = Math.floor(Date.now() / 1_000),
    maximumAgeSeconds = VerificationQRMaximumAgeSeconds
  } = {}
) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "bitchat:" || url.hostname !== "verify") return null;
    const payload = {
      v: Number.parseInt(url.searchParams.get("v") ?? "", 10),
      noiseKeyHex: url.searchParams.get("noise") ?? "",
      signKeyHex: url.searchParams.get("sign") ?? "",
      npub: url.searchParams.get("npub") || null,
      nickname: url.searchParams.get("nick") ?? "",
      ts: Number.parseInt(url.searchParams.get("ts") ?? "", 10),
      nonceB64: url.searchParams.get("nonce") ?? "",
      sigHex: url.searchParams.get("sig") ?? ""
    };
    if (payload.v !== 1
      || !isHex(payload.noiseKeyHex, 32)
      || !isHex(payload.signKeyHex, 32)
      || !isHex(payload.sigHex, 64)
      || !payload.nickname
      || !Number.isSafeInteger(payload.ts)) return null;
    const age = nowSeconds - payload.ts;
    if (age > maximumAgeSeconds || age < -maximumAgeSeconds) return null;
    if (base64URLToBytes(payload.nonceB64, 24)?.length !== 16) return null;
    const verified = ed25519.verify(
      hexToBytes(payload.sigHex),
      canonicalQRBytes(payload),
      hexToBytes(payload.signKeyHex)
    );
    return verified ? payload : null;
  } catch {
    return null;
  }
}

function encodeTLV(type, value) {
  if (!(value instanceof Uint8Array) || value.length > 255) {
    throw new Error("TLV de vérification BitChat invalide");
  }
  return concatBytes(Uint8Array.of(type, value.length), value);
}

function parseVerificationTLV(data) {
  if (!(data instanceof Uint8Array)) return null;
  const values = new Map();
  let offset = 0;
  while (offset + 2 <= data.length) {
    const type = data[offset++];
    const length = data[offset++];
    if (offset + length > data.length) return null;
    values.set(type, data.slice(offset, offset + length));
    offset += length;
  }
  return offset === data.length ? values : null;
}

export function encodeVerifyChallenge(noiseKeyHex, nonce) {
  if (!isHex(noiseKeyHex, 32) || !(nonce instanceof Uint8Array) || nonce.length !== 16) {
    throw new Error("Challenge de vérification BitChat invalide");
  }
  return concatBytes(
    Uint8Array.of(BitChatNoisePayloadType.verifyChallenge),
    encodeTLV(0x01, utf8ToBytes(noiseKeyHex.toLowerCase())),
    encodeTLV(0x02, nonce)
  );
}

export function parseVerifyChallenge(data) {
  const values = parseVerificationTLV(data);
  if (!values) return null;
  const noiseKeyHex = new TextDecoder().decode(values.get(0x01) ?? new Uint8Array());
  const nonce = values.get(0x02);
  return isHex(noiseKeyHex, 32) && nonce?.length === 16
    ? { noiseKeyHex: noiseKeyHex.toLowerCase(), nonce }
    : null;
}

function responseSigningBytes(noiseKeyHex, nonce) {
  const noiseBytes = utf8ToBytes(noiseKeyHex.toLowerCase());
  return concatBytes(
    utf8ToBytes(RESPONSE_CONTEXT),
    Uint8Array.of(noiseBytes.length),
    noiseBytes,
    nonce
  );
}

export function encodeVerifyResponse(identity, noiseKeyHex, nonce) {
  if (identity?.signingSecretKey?.length !== 32
    || !isHex(noiseKeyHex, 32)
    || !(nonce instanceof Uint8Array)
    || nonce.length !== 16) {
    throw new Error("Réponse de vérification BitChat invalide");
  }
  const normalizedNoiseKey = noiseKeyHex.toLowerCase();
  const signature = ed25519.sign(
    responseSigningBytes(normalizedNoiseKey, nonce),
    identity.signingSecretKey
  );
  return concatBytes(
    Uint8Array.of(BitChatNoisePayloadType.verifyResponse),
    encodeTLV(0x01, utf8ToBytes(normalizedNoiseKey)),
    encodeTLV(0x02, nonce),
    encodeTLV(0x03, signature)
  );
}

export function parseAndVerifyResponse(data, signingPublicKey) {
  const values = parseVerificationTLV(data);
  if (!values || signingPublicKey?.length !== 32) return null;
  const noiseKeyHex = new TextDecoder().decode(values.get(0x01) ?? new Uint8Array());
  const nonce = values.get(0x02);
  const signature = values.get(0x03);
  if (!isHex(noiseKeyHex, 32) || nonce?.length !== 16 || signature?.length !== 64) return null;
  const verified = ed25519.verify(
    signature,
    responseSigningBytes(noiseKeyHex, nonce),
    signingPublicKey
  );
  return verified ? { noiseKeyHex: noiseKeyHex.toLowerCase(), nonce } : null;
}

export function fingerprintForNoiseKey(noisePublicKey) {
  return noisePublicKey?.length === 32 ? bytesToHex(sha256(noisePublicKey)) : null;
}
