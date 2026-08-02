import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { unzlibSync } from "fflate";
import {
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  equalBytes,
  hexToBytes,
  randomBytes,
  readUint16BE,
  toExactLength,
  utf8ToBytes,
  writeUint16BE,
  writeUint32BE,
  writeUint64BE
} from "../../core/bytes.js";
import { BitChatWireContract } from "./wire-contract.js";

export const BitChatNetwork = Object.freeze({
  mainnet: Object.freeze({
    id: "mainnet",
    label: "Production",
    serviceUUID: BitChatWireContract.bluetooth.mainnetServiceUuid
  }),
  testnet: Object.freeze({
    id: "testnet",
    label: "Debug / testnet",
    serviceUUID: BitChatWireContract.bluetooth.testnetServiceUuid
  })
});

export const BitChatBLE = Object.freeze({
  characteristicUUID: BitChatWireContract.bluetooth.characteristicUuid,
  defaultTTL: BitChatWireContract.bluetooth.defaultTtl,
  fragmentChunkBytes: BitChatWireContract.bluetooth.fragmentChunkBytes
});

export const BitChatMessageType = BitChatWireContract.messageTypes;

export const BitChatNoisePayloadType = BitChatWireContract.noise.payloadTypes;

export const BitChatFileTransferLimits = BitChatWireContract.fileTransfer;
export const BitChatMaximumFrameBytes = BitChatFileTransferLimits.maximumPayloadBytes + 132 * 1024;

const FLAG_RECIPIENT = 0x01;
const FLAG_SIGNATURE = 0x02;
const FLAG_COMPRESSED = 0x04;
const FLAG_ROUTE = 0x08;
const FLAG_RSR = 0x10;
const SIGNATURE_BYTES = 64;

function optimalBlockSize(size) {
  return [256, 512, 1024, 2048].find((candidate) => size + 16 <= candidate) ?? size;
}

export function padBitChatFrame(bytes) {
  const target = optimalBlockSize(bytes.length);
  const paddingLength = target - bytes.length;
  if (paddingLength <= 0 || paddingLength > 255) return bytes;
  return concatBytes(bytes, new Uint8Array(paddingLength).fill(paddingLength));
}

function unpadBitChatFrame(bytes) {
  if (!bytes.length) return bytes;
  const paddingLength = bytes.at(-1);
  if (!paddingLength || paddingLength > bytes.length) return bytes;
  const padding = bytes.subarray(bytes.length - paddingLength);
  return padding.every((byte) => byte === paddingLength)
    ? bytes.subarray(0, bytes.length - paddingLength)
    : bytes;
}

export function encodeBitChatPacket(packet, { padding = false } = {}) {
  const version = packet.version ?? 1;
  if (version !== 1 && version !== 2) throw new Error("Unsupported BitChat packet version");

  const senderID = toExactLength(packet.senderID ?? new Uint8Array(), 8);
  const recipientID = packet.recipientID ? toExactLength(packet.recipientID, 8) : null;
  const signature = packet.signature ? toExactLength(packet.signature, SIGNATURE_BYTES) : null;
  const route = version >= 2 ? (packet.route ?? []).map((hop) => toExactLength(hop, 8)) : [];
  if (route.length > 255) throw new Error("BitChat route is too long");
  const payload = packet.wirePayload ?? packet.payload ?? new Uint8Array();
  if (version === 1 && payload.length > 0xffff) throw new Error("BitChat v1 payload is too large");

  let flags = 0;
  if (recipientID) flags |= FLAG_RECIPIENT;
  if (signature) flags |= FLAG_SIGNATURE;
  if (packet.isCompressed) flags |= FLAG_COMPRESSED;
  if (route.length) flags |= FLAG_ROUTE;
  if (packet.isRSR) flags |= FLAG_RSR;

  const header = concatBytes(
    Uint8Array.of(version, packet.type, packet.ttl ?? BitChatBLE.defaultTTL),
    writeUint64BE(packet.timestamp ?? Date.now()),
    Uint8Array.of(flags),
    version === 2 ? writeUint32BE(payload.length) : writeUint16BE(payload.length)
  );
  const routeBytes = route.length
    ? concatBytes(Uint8Array.of(route.length), ...route)
    : new Uint8Array();
  const encoded = concatBytes(
    header,
    senderID,
    recipientID,
    routeBytes,
    payload,
    signature
  );
  return padding ? padBitChatFrame(encoded) : encoded;
}

export function decodeBitChatPacket(input) {
  const direct = decodeBitChatPacketCore(input);
  if (direct) return direct;
  const unpadded = unpadBitChatFrame(input);
  return unpadded.length === input.length ? null : decodeBitChatPacketCore(unpadded);
}

function decodeBitChatPacketCore(bytes) {
  if (bytes.length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const version = bytes[offset++];
  if (version !== 1 && version !== 2) return null;
  const type = bytes[offset++];
  const ttl = bytes[offset++];
  const timestamp = Number(view.getBigUint64(offset, false));
  offset += 8;
  const flags = bytes[offset++];
  const compressed = Boolean(flags & FLAG_COMPRESSED);
  const payloadLength = version === 2 ? view.getUint32(offset, false) : view.getUint16(offset, false);
  offset += version === 2 ? 4 : 2;
  if (offset + 8 > bytes.length) return null;
  const senderID = bytes.slice(offset, offset + 8);
  offset += 8;
  let recipientID = null;
  if (flags & FLAG_RECIPIENT) {
    if (offset + 8 > bytes.length) return null;
    recipientID = bytes.slice(offset, offset + 8);
    offset += 8;
  }
  let route = [];
  if (version >= 2 && flags & FLAG_ROUTE) {
    if (offset >= bytes.length) return null;
    const routeCount = bytes[offset++];
    if (offset + routeCount * 8 > bytes.length) return null;
    route = Array.from({ length: routeCount }, () => {
      const hop = bytes.slice(offset, offset + 8);
      offset += 8;
      return hop;
    });
  }
  if (offset + payloadLength > bytes.length) return null;
  const wirePayload = bytes.slice(offset, offset + payloadLength);
  let payload = wirePayload;
  offset += payloadLength;
  if (compressed) {
    const sizeFieldBytes = version === 2 ? 4 : 2;
    if (payload.length <= sizeFieldBytes) return null;
    const payloadView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const originalSize = version === 2
      ? payloadView.getUint32(0, false)
      : payloadView.getUint16(0, false);
    if (originalSize > 20_000_000) return null;
    try {
      payload = unzlibSync(payload.slice(sizeFieldBytes));
    } catch {
      return null;
    }
    if (payload.length !== originalSize) return null;
  }
  let signature = null;
  if (flags & FLAG_SIGNATURE) {
    if (offset + SIGNATURE_BYTES > bytes.length) return null;
    signature = bytes.slice(offset, offset + SIGNATURE_BYTES);
    offset += SIGNATURE_BYTES;
  }
  return {
    version,
    type,
    ttl,
    timestamp,
    senderID,
    recipientID,
    payload,
    wirePayload: compressed ? wirePayload : null,
    isCompressed: compressed,
    signature,
    route,
    isRSR: Boolean(flags & FLAG_RSR)
  };
}

export function encodePacketForSigning(packet) {
  return encodeBitChatPacket({
    ...packet,
    ttl: 0,
    signature: null,
    isRSR: false
  }, { padding: true });
}

export function signBitChatPacket(packet, signingSecretKey) {
  return {
    ...packet,
    signature: ed25519.sign(encodePacketForSigning(packet), signingSecretKey)
  };
}

export function verifyBitChatPacket(packet, signingPublicKey) {
  if (!packet.signature || signingPublicKey?.length !== 32) return false;
  return ed25519.verify(
    packet.signature,
    encodePacketForSigning(packet),
    signingPublicKey,
    { zip215: false }
  );
}

export function peerIDFromNoisePublicKey(publicKey) {
  return sha256(publicKey).slice(0, 8);
}

export function encodeAnnouncement({ nickname, noisePublicKey, signingPublicKey, capabilities = 0 }) {
  const nicknameBytes = utf8ToBytes(nickname);
  if (!nicknameBytes.length || nicknameBytes.length > 255) throw new Error("Invalid announce nickname");
  const capabilityBytes = [];
  let value = BigInt(capabilities);
  do {
    capabilityBytes.push(Number(value & 0xffn));
    value >>= 8n;
  } while (value);

  return concatBytes(
    Uint8Array.of(0x01, nicknameBytes.length),
    nicknameBytes,
    Uint8Array.of(0x02, noisePublicKey.length),
    noisePublicKey,
    Uint8Array.of(0x03, signingPublicKey.length),
    signingPublicKey,
    Uint8Array.of(0x05, capabilityBytes.length, ...capabilityBytes)
  );
}

export function decodeAnnouncement(payload) {
  let offset = 0;
  const values = new Map();
  while (offset + 2 <= payload.length) {
    const type = payload[offset++];
    const length = payload[offset++];
    if (offset + length > payload.length) return null;
    values.set(type, payload.slice(offset, offset + length));
    offset += length;
  }
  try {
    const nickname = bytesToUtf8(values.get(0x01) ?? new Uint8Array());
    const noisePublicKey = values.get(0x02);
    const signingPublicKey = values.get(0x03);
    if (!nickname || noisePublicKey?.length !== 32 || signingPublicKey?.length !== 32) return null;
    return { nickname, noisePublicKey, signingPublicKey };
  } catch {
    return null;
  }
}

export function createSignedAnnouncementPacket(identity, nickname, timestamp = Date.now()) {
  return signBitChatPacket({
    version: 1,
    type: BitChatMessageType.announce,
    ttl: BitChatBLE.defaultTTL,
    timestamp,
    senderID: identity.peerID,
    recipientID: null,
    payload: encodeAnnouncement({
      nickname,
      noisePublicKey: identity.noisePublicKey,
      signingPublicKey: identity.signingPublicKey
    }),
    signature: null
  }, identity.signingSecretKey);
}

export function createSignedPublicMessagePacket(identity, content, timestamp = Date.now()) {
  return signBitChatPacket({
    version: 1,
    type: BitChatMessageType.message,
    ttl: BitChatBLE.defaultTTL,
    timestamp,
    senderID: identity.peerID,
    recipientID: null,
    payload: utf8ToBytes(content),
    signature: null
  }, identity.signingSecretKey);
}

export function decodePublicMessage(packet) {
  try {
    return bytesToUtf8(packet.payload);
  } catch {
    return null;
  }
}

export function encodePrivateMessagePayload(messageID, content) {
  const id = utf8ToBytes(messageID);
  const message = utf8ToBytes(content);
  if (id.length > 255 || message.length > 255) throw new Error("Private message exceeds BitChat TLV limits");
  return concatBytes(
    Uint8Array.of(BitChatNoisePayloadType.privateMessage, 0x00, id.length),
    id,
    Uint8Array.of(0x01, message.length),
    message
  );
}

export function decodePrivateMessagePayload(payload) {
  if (payload[0] !== BitChatNoisePayloadType.privateMessage) return null;
  let offset = 1;
  const values = new Map();
  while (offset + 2 <= payload.length) {
    const type = payload[offset++];
    const length = payload[offset++];
    if (offset + length > payload.length) return null;
    values.set(type, payload.slice(offset, offset + length));
    offset += length;
  }
  try {
    const id = bytesToUtf8(values.get(0x00) ?? new Uint8Array());
    const content = bytesToUtf8(values.get(0x01) ?? new Uint8Array());
    return id && content ? { id, content } : null;
  } catch {
    return null;
  }
}

export function encodeMessageReceiptPayload(type, messageID) {
  const rawType = typeof type === "string" ? BitChatNoisePayloadType[type] : type;
  if (![BitChatNoisePayloadType.delivered, BitChatNoisePayloadType.readReceipt].includes(rawType)) {
    throw new Error("Unsupported BitChat receipt type");
  }
  const id = utf8ToBytes(messageID);
  if (!id.length || id.length > 255) throw new Error("Invalid BitChat receipt message ID");
  return concatBytes(Uint8Array.of(rawType), id);
}

export function decodeNoisePayload(payload) {
  if (!(payload instanceof Uint8Array) || payload.length < 1) return null;
  if (payload[0] === BitChatNoisePayloadType.privateMessage) {
    const message = decodePrivateMessagePayload(payload);
    return message ? { type: "privateMessage", ...message } : null;
  }
  if (payload[0] === BitChatNoisePayloadType.delivered
    || payload[0] === BitChatNoisePayloadType.readReceipt) {
    try {
      const messageID = bytesToUtf8(payload.slice(1));
      if (!messageID || utf8ToBytes(messageID).length > 255) return null;
      return {
        type: payload[0] === BitChatNoisePayloadType.delivered ? "delivered" : "readReceipt",
        messageID
      };
    } catch {
      return null;
    }
  }
  if (payload[0] === BitChatNoisePayloadType.verifyChallenge
    || payload[0] === BitChatNoisePayloadType.verifyResponse) {
    return {
      type: payload[0] === BitChatNoisePayloadType.verifyChallenge
        ? "verifyChallenge"
        : "verifyResponse",
      data: payload.slice(1)
    };
  }
  const privateFileAliases = BitChatWireContract.noise.decodeAliases.privateFile ?? [];
  if (payload[0] === BitChatNoisePayloadType.privateFile
    || privateFileAliases.includes(payload[0])) {
    const file = decodeFileTransferPayload(payload.slice(1));
    return file ? { type: "privateFile", file } : null;
  }
  return { type: "unsupported", rawType: payload[0], data: payload.slice(1) };
}

function encodeFileTLV(type, value, lengthBytes = 2) {
  const length = lengthBytes === 4 ? writeUint32BE(value.length) : writeUint16BE(value.length);
  return concatBytes(Uint8Array.of(type), length, value);
}

export function encodeFileTransferPayload({ fileName, mimeType, content }) {
  if (!(content instanceof Uint8Array)
    || !content.length
    || content.length > BitChatFileTransferLimits.maximumPayloadBytes) {
    throw new Error("BitChat file content is outside protocol limits");
  }
  const nameBytes = utf8ToBytes(fileName);
  const normalizedMimeType = mimeType || "application/octet-stream";
  if (normalizedMimeType.startsWith("image/")
    && content.length > BitChatFileTransferLimits.maximumImageBytes) {
    throw new Error("BitChat image exceeds the native protocol limit");
  }
  if (normalizedMimeType.startsWith("audio/")
    && content.length > BitChatFileTransferLimits.maximumVoiceNoteBytes) {
    throw new Error("BitChat voice note exceeds the native protocol limit");
  }
  const mimeBytes = utf8ToBytes(normalizedMimeType);
  if (!nameBytes.length || nameBytes.length > 0xffff || mimeBytes.length > 0xffff) {
    throw new Error("BitChat file metadata is outside TLV limits");
  }
  return concatBytes(
    encodeFileTLV(0x01, nameBytes),
    encodeFileTLV(0x02, writeUint32BE(content.length)),
    encodeFileTLV(0x03, mimeBytes),
    encodeFileTLV(0x04, content, 4)
  );
}

export function decodeFileTransferPayload(payload) {
  if (!(payload instanceof Uint8Array) || !payload.length || payload.length > BitChatMaximumFrameBytes) {
    return null;
  }
  let offset = 0;
  let fileName = null;
  let declaredSize = null;
  let mimeType = "application/octet-stream";
  const contentParts = [];
  let contentBytes = 0;
  try {
    while (offset < payload.length) {
      if (offset + 3 > payload.length) return null;
      const type = payload[offset++];
      const lengthBytes = type === 0x04 ? 4 : 2;
      if (offset + lengthBytes > payload.length) return null;
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const length = lengthBytes === 4
        ? view.getUint32(offset, false)
        : view.getUint16(offset, false);
      offset += lengthBytes;
      if (offset + length > payload.length) return null;
      const value = payload.slice(offset, offset + length);
      offset += length;
      if (type === 0x01) fileName = bytesToUtf8(value);
      else if (type === 0x02) {
        if (value.length !== 4 && value.length !== 8) return null;
        const size = value.reduce((total, byte) => (total << 8n) | BigInt(byte), 0n);
        if (size > BigInt(BitChatFileTransferLimits.maximumPayloadBytes)) return null;
        declaredSize = Number(size);
      } else if (type === 0x03) mimeType = bytesToUtf8(value);
      else if (type === 0x04) {
        contentBytes += value.length;
        if (contentBytes > BitChatFileTransferLimits.maximumPayloadBytes) return null;
        contentParts.push(value);
      }
    }
  } catch {
    return null;
  }
  if (!fileName || !contentParts.length || declaredSize !== contentBytes) return null;
  return {
    fileName,
    fileSize: contentBytes,
    mimeType,
    content: concatBytes(...contentParts)
  };
}

export function encodeAuthenticatedPeerState(signingPublicKey) {
  return concatBytes(
    Uint8Array.of(0x21, 0x01, 0x01, 0x01, 0x00, 0x02, signingPublicKey.length),
    signingPublicKey
  );
}

export function makeFragmentPackets(packet, chunkSize = BitChatBLE.fragmentChunkBytes) {
  const fullFrame = encodeBitChatPacket(packet, {
    padding: packet.type === BitChatMessageType.noiseHandshake
      || packet.type === BitChatMessageType.noiseEncrypted
  });
  if (fullFrame.length <= 512) return [packet];
  const fragmentID = randomBytes(8);
  const total = Math.ceil(fullFrame.length / chunkSize);
  if (total > 0xffff) throw new Error("BitChat message requires too many fragments");
  const packets = [];
  for (let index = 0; index < total; index += 1) {
    const chunk = fullFrame.slice(index * chunkSize, (index + 1) * chunkSize);
    packets.push({
      version: 1,
      type: BitChatMessageType.fragment,
      ttl: packet.ttl,
      timestamp: packet.timestamp,
      senderID: packet.senderID,
      recipientID: packet.recipientID,
      payload: concatBytes(
        fragmentID,
        writeUint16BE(index),
        writeUint16BE(total),
        Uint8Array.of(packet.type),
        chunk
      ),
      signature: null
    });
  }
  return packets;
}

export class BitChatFragmentAssembler {
  constructor({ maximumAssemblies = 32, maximumBytes = BitChatMaximumFrameBytes } = {}) {
    this.maximumAssemblies = maximumAssemblies;
    this.maximumBytes = maximumBytes;
    this.assemblies = new Map();
  }

  append(packet) {
    if (packet.type !== BitChatMessageType.fragment || packet.payload.length < 13) return packet;
    const id = bytesToHex(packet.payload.slice(0, 8));
    const index = readUint16BE(packet.payload, 8);
    const total = readUint16BE(packet.payload, 10);
    const originalType = packet.payload[12];
    if (!total || index >= total || total > 10_000) return null;

    if (!this.assemblies.has(id)) {
      if (this.assemblies.size >= this.maximumAssemblies) {
        this.assemblies.delete(this.assemblies.keys().next().value);
      }
      this.assemblies.set(id, {
        originalType,
        total,
        chunks: new Map(),
        bytes: 0,
        createdAt: Date.now()
      });
    }
    const assembly = this.assemblies.get(id);
    if (assembly.total !== total || assembly.originalType !== originalType) {
      this.assemblies.delete(id);
      return null;
    }
    if (!assembly.chunks.has(index)) {
      const chunk = packet.payload.slice(13);
      assembly.chunks.set(index, chunk);
      assembly.bytes += chunk.length;
    }
    if (assembly.bytes > this.maximumBytes) {
      this.assemblies.delete(id);
      return null;
    }
    if (assembly.chunks.size !== total) return null;
    const fullFrame = concatBytes(
      ...Array.from({ length: total }, (_, chunkIndex) => assembly.chunks.get(chunkIndex))
    );
    this.assemblies.delete(id);
    return decodeBitChatPacket(fullFrame);
  }
}

export class BitChatNotificationAssembler {
  constructor({ maximumBytes = BitChatMaximumFrameBytes } = {}) {
    this.maximumBytes = maximumBytes;
    this.buffer = new Uint8Array();
  }

  append(chunk) {
    this.buffer = concatBytes(this.buffer, chunk);
    if (this.buffer.length > this.maximumBytes) {
      this.buffer = new Uint8Array();
      return [];
    }
    const frames = [];
    while (this.buffer.length >= 22) {
      const version = this.buffer[0];
      if (version !== 1 && version !== 2) {
        const paddingLength = this.buffer[0];
        if (paddingLength > 0
          && paddingLength <= this.buffer.length
          && this.buffer.slice(0, paddingLength).every((byte) => byte === paddingLength)) {
          this.buffer = this.buffer.slice(paddingLength);
        } else {
          this.buffer = this.buffer.slice(1);
        }
        continue;
      }
      const flags = this.buffer[11];
      const headerSize = version === 2 ? 16 : 14;
      const payloadLength = version === 2
        ? new DataView(this.buffer.buffer, this.buffer.byteOffset).getUint32(12, false)
        : readUint16BE(this.buffer, 12);
      let frameLength = headerSize + 8 + payloadLength;
      if (flags & FLAG_RECIPIENT) frameLength += 8;
      if (flags & FLAG_SIGNATURE) frameLength += SIGNATURE_BYTES;
      if (version >= 2 && flags & FLAG_ROUTE) {
        const routeOffset = headerSize + 8 + ((flags & FLAG_RECIPIENT) ? 8 : 0);
        if (this.buffer.length <= routeOffset) break;
        frameLength += 1 + this.buffer[routeOffset] * 8;
      }
      if (frameLength > this.maximumBytes) {
        this.buffer = new Uint8Array();
        break;
      }
      if (this.buffer.length < frameLength) break;
      frames.push(this.buffer.slice(0, frameLength));
      this.buffer = this.buffer.slice(frameLength);
      if (this.buffer.length) {
        const paddingLength = this.buffer[0];
        if (paddingLength > 0
          && paddingLength <= this.buffer.length
          && this.buffer.slice(0, paddingLength).every((byte) => byte === paddingLength)) {
          this.buffer = this.buffer.slice(paddingLength);
        }
      }
    }
    return frames;
  }
}

export function isPacketForPeer(packet, peerID) {
  return Boolean(packet.recipientID && equalBytes(packet.recipientID, peerID));
}

export function packetSenderHex(packet) {
  return bytesToHex(packet.senderID);
}

export function packetRecipientHex(packet) {
  return packet.recipientID ? bytesToHex(packet.recipientID) : null;
}

export function routingIDFromExternalID(externalID) {
  return hexToBytes(String(externalID ?? "").replace(/^ble-/, ""));
}
