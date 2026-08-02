import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  finalizeEvent,
  getPublicKey,
  verifyEvent
} from "nostr-tools/pure";
import {
  base64URLToBytes,
  bytesToBase64URL,
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes
} from "../../core/bytes.js";
import {
  BitChatBLE,
  BitChatMessageType,
  decodeBitChatPacket,
  decodeNoisePayload,
  encodeBitChatPacket,
  encodeMessageReceiptPayload,
  encodePrivateMessagePayload
} from "./bit-chat-codec.js";
import { BitChatWireContract } from "./wire-contract.js";

const MAXIMUM_ENVELOPE_BYTES = 64 * 1024;
const PRIVATE_ENVELOPE_INFO = utf8ToBytes("nip44-v2");
const EMPTY_BYTES = new Uint8Array();

export const BitChatNostrContract = BitChatWireContract.nostr;

function assertSecretKey(secretKey) {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    throw new Error("Clé privée Nostr invalide");
  }
}

function assertXOnlyPublicKey(publicKey) {
  const bytes = hexToBytes(publicKey);
  if (bytes?.length !== 32) throw new Error("Clé publique Nostr invalide");
  return bytes;
}

function randomTimestamp(now = Date.now()) {
  const privacyOffset = Math.floor(Math.random() * 1801) - 900;
  return Math.floor(now / 1000) + privacyOffset;
}

function deriveKey(secretKey, publicKey, parity) {
  const compressedPublicKey = concatBytes(Uint8Array.of(parity), publicKey);
  const sharedSecret = secp256k1.getSharedSecret(secretKey, compressedPublicKey, true);
  return hkdf(sha256, sharedSecret, EMPTY_BYTES, PRIVATE_ENVELOPE_INFO, 32);
}

function encryptPrivateEnvelope(plaintext, recipientPublicKey, senderSecretKey) {
  assertSecretKey(senderSecretKey);
  const recipient = assertXOnlyPublicKey(recipientPublicKey);
  const nonce = randomBytes(24);
  const key = deriveKey(senderSecretKey, recipient, 0x02);
  const ciphertextAndTag = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(plaintext));
  return `${BitChatNostrContract.privateEnvelopePrefix}${bytesToBase64URL(concatBytes(nonce, ciphertextAndTag))}`;
}

function decryptPrivateEnvelope(ciphertext, senderPublicKey, recipientSecretKey) {
  assertSecretKey(recipientSecretKey);
  const encoded = String(ciphertext ?? "");
  if (!encoded.startsWith(BitChatNostrContract.privateEnvelopePrefix)
    || encoded.length > MAXIMUM_ENVELOPE_BYTES) {
    throw new Error("Chiffrement privé BitChat invalide");
  }
  const combined = base64URLToBytes(
    encoded.slice(BitChatNostrContract.privateEnvelopePrefix.length),
    MAXIMUM_ENVELOPE_BYTES
  );
  const sender = assertXOnlyPublicKey(senderPublicKey);
  if (!combined || combined.length <= 40) throw new Error("Chiffrement privé BitChat invalide");
  const nonce = combined.slice(0, 24);
  const encrypted = combined.slice(24);
  for (const parity of [0x02, 0x03]) {
    try {
      const key = deriveKey(recipientSecretKey, sender, parity);
      return new TextDecoder("utf-8", { fatal: true })
        .decode(xchacha20poly1305(key, nonce).decrypt(encrypted));
    } catch {
      // BitChat accepts either Y parity for x-only secp256k1 public keys.
    }
  }
  throw new Error("Impossible de déchiffrer l’enveloppe privée BitChat");
}

function parseNestedEvent(value) {
  if (value.length > MAXIMUM_ENVELOPE_BYTES) throw new Error("Événement Nostr privé trop volumineux");
  const event = JSON.parse(value);
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("Événement Nostr privé invalide");
  }
  return event;
}

function verifyFreshEvent(event) {
  return verifyEvent({
    id: event?.id,
    pubkey: event?.pubkey,
    created_at: event?.created_at,
    kind: event?.kind,
    tags: event?.tags,
    content: event?.content,
    sig: event?.sig
  });
}

/**
 * Exact browser implementation of BitChat's proprietary kind 14/13/1059
 * private envelope. The kind numbers are historical; this is not NIP-44/59.
 */
export function createBitChatPrivateEnvelope({
  content,
  recipientPublicKey,
  senderSecretKey,
  now = Date.now()
}) {
  assertSecretKey(senderSecretKey);
  const senderPublicKey = getPublicKey(senderSecretKey);
  assertXOnlyPublicKey(recipientPublicKey);
  const rumor = {
    id: "",
    pubkey: senderPublicKey,
    created_at: Math.floor(now / 1000),
    kind: BitChatNostrContract.privateRumorKind,
    tags: [],
    content: String(content)
  };
  const seal = finalizeEvent({
    created_at: randomTimestamp(now),
    kind: BitChatNostrContract.privateSealKind,
    tags: [],
    content: encryptPrivateEnvelope(
      JSON.stringify(rumor),
      recipientPublicKey,
      senderSecretKey
    )
  }, senderSecretKey);
  const wrapperSecretKey = secp256k1.utils.randomSecretKey();
  return finalizeEvent({
    created_at: randomTimestamp(now),
    kind: BitChatNostrContract.privateGiftWrapKind,
    tags: [["p", recipientPublicKey]],
    content: encryptPrivateEnvelope(
      JSON.stringify(seal),
      recipientPublicKey,
      wrapperSecretKey
    )
  }, wrapperSecretKey);
}

export function openBitChatPrivateEnvelope({
  giftWrap,
  recipientSecretKey
}) {
  assertSecretKey(recipientSecretKey);
  const recipientPublicKey = getPublicKey(recipientSecretKey);
  if (giftWrap?.kind !== BitChatNostrContract.privateGiftWrapKind
    || giftWrap.content?.length > MAXIMUM_ENVELOPE_BYTES
    || JSON.stringify(giftWrap.tags) !== JSON.stringify([["p", recipientPublicKey]])
    || !verifyFreshEvent(giftWrap)) {
    throw new Error("Enveloppe Nostr externe invalide ou mal adressée");
  }
  const seal = parseNestedEvent(decryptPrivateEnvelope(
    giftWrap.content,
    giftWrap.pubkey,
    recipientSecretKey
  ));
  if (seal.kind !== BitChatNostrContract.privateSealKind
    || !Array.isArray(seal.tags)
    || seal.tags.length !== 0
    || !verifyFreshEvent(seal)) {
    throw new Error("Signature du sceau Nostr invalide");
  }
  const rumor = parseNestedEvent(decryptPrivateEnvelope(
    seal.content,
    seal.pubkey,
    recipientSecretKey
  ));
  const validInnerTags = Array.isArray(rumor.tags)
    && (rumor.tags.length === 0
      || JSON.stringify(rumor.tags) === JSON.stringify([["p", recipientPublicKey]]));
  if (rumor.kind !== BitChatNostrContract.privateRumorKind
    || !validInnerTags
    || rumor.sig != null
    || rumor.pubkey !== seal.pubkey
    || typeof rumor.content !== "string"
    || !Number.isInteger(rumor.created_at)) {
    throw new Error("Message Nostr interne invalide");
  }
  return {
    content: rumor.content,
    senderPublicKey: seal.pubkey,
    timestamp: rumor.created_at * 1000
  };
}

function encodeEmbeddedNoisePayload(payload, senderPeerID, timestamp) {
  const packet = encodeBitChatPacket({
    version: 1,
    type: BitChatMessageType.noiseEncrypted,
    ttl: BitChatBLE.defaultTTL,
    timestamp,
    senderID: senderPeerID,
    recipientID: null,
    payload,
    signature: null
  });
  return `bitchat1:${bytesToBase64URL(packet)}`;
}

export function encodeBitChatNostrPrivateMessage({
  content,
  messageID,
  senderPeerID,
  timestamp = Date.now()
}) {
  return encodeEmbeddedNoisePayload(
    encodePrivateMessagePayload(messageID, content),
    senderPeerID,
    timestamp
  );
}

export function encodeBitChatNostrMessageReceipt({
  type,
  messageID,
  senderPeerID,
  timestamp = Date.now()
}) {
  return encodeEmbeddedNoisePayload(
    encodeMessageReceiptPayload(type, messageID),
    senderPeerID,
    timestamp
  );
}

export function decodeBitChatNostrPayload(content) {
  if (!String(content ?? "").startsWith("bitchat1:")) return null;
  const packetBytes = base64URLToBytes(String(content).slice("bitchat1:".length), MAXIMUM_ENVELOPE_BYTES);
  if (!packetBytes) return null;
  try {
    const packet = decodeBitChatPacket(packetBytes);
    if (packet.type !== BitChatMessageType.noiseEncrypted) return null;
    const payload = decodeNoisePayload(packet.payload);
    return payload ? {
      ...payload,
      senderPeerID: bytesToHex(packet.senderID),
      timestamp: Number(packet.timestamp)
    } : null;
  } catch {
    return null;
  }
}

export function decodeBitChatNostrPrivateMessage(content) {
  const payload = decodeBitChatNostrPayload(content);
  if (payload?.type !== "privateMessage") return null;
  const { type: _, ...message } = payload;
  return message;
}
