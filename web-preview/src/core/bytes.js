const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function concatBytes(...parts) {
  const arrays = parts.filter(Boolean).map((part) => (
    part instanceof Uint8Array ? part : new Uint8Array(part)
  ));
  const result = new Uint8Array(arrays.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of arrays) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function utf8ToBytes(value) {
  return encoder.encode(String(value ?? ""));
}

export function bytesToUtf8(value) {
  return decoder.decode(value);
}

export function bytesToHex(value) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(normalized)) return null;
  return Uint8Array.from(
    normalized.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []
  );
}

export function equalBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function bytesToBase64URL(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function base64URLToBytes(value, maximumBytes = Number.POSITIVE_INFINITY) {
  const encoded = String(value ?? "");
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return null;
  if (Math.ceil(encoded.length * 3 / 4) > maximumBytes) return null;
  try {
    const padded = encoded
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(padded);
    if (binary.length > maximumBytes) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function readUint16BE(bytes, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, false);
}

export function writeUint16BE(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
}

export function writeUint32BE(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

export function writeUint64BE(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

export function writeUint64LE(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

export function toExactLength(value, length) {
  const result = new Uint8Array(length);
  result.set(value.subarray(0, length));
  return result;
}
