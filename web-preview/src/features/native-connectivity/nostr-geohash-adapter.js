import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent
} from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { bytesToHex, hexToBytes } from "../../core/bytes.js";
import { InputValidator } from "../../core/input-validator.js";
import {
  BitChatNostrContract,
  createBitChatPrivateEnvelope,
  decodeBitChatNostrPayload,
  encodeBitChatNostrMessageReceipt,
  encodeBitChatNostrPrivateMessage,
  openBitChatPrivateEnvelope
} from "./bit-chat-nostr-envelope.js";

const IDENTITY_STORAGE_KEY = "bitchat-web-nostr-identity-v1";
const DEFAULT_RELAYS = Object.freeze([
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://offchain.pub"
]);

function normalizeRelayURL(value) {
  try {
    const raw = String(value ?? "").trim();
    const url = new URL(raw.includes("://") ? raw : `wss://${raw}`);
    if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) return null;
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function readOrCreateSecretKey(storage, storageKey) {
  const saved = hexToBytes(storage?.getItem(storageKey));
  if (saved?.length === 32) {
    try {
      getPublicKey(saved);
      return saved;
    } catch {
      // Replace corrupted or out-of-range browser-only key material below.
    }
  }
  const secretKey = generateSecretKey();
  storage?.setItem(storageKey, bytesToHex(secretKey));
  return secretKey;
}

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

/**
 * Nostr adapter for BitChat's public geohash events and proprietary private
 * envelopes. Private messages intentionally use the native BitChat contract
 * instead of substituting the similarly numbered NIPs.
 */
export class NostrGeohashAdapter {
  static defaultRelays = DEFAULT_RELAYS;

  constructor({
    storage = globalThis.sessionStorage,
    identityStorageKey = IDENTITY_STORAGE_KEY,
    nickname,
    senderPeerID,
    onStatus = () => {},
    onPeer = () => {},
    onPeerRemoved = () => {},
    onMessage = () => {},
    onDelivery = () => {},
    onError = () => {}
  }) {
    this.storage = storage;
    this.identityStorageKey = identityStorageKey;
    this.secretKey = readOrCreateSecretKey(storage, `${identityStorageKey}:u33dc`);
    this.publicKey = getPublicKey(this.secretKey);
    this.nickname = nickname;
    this.senderPeerID = senderPeerID;
    this.onStatus = onStatus;
    this.onPeer = onPeer;
    this.onPeerRemoved = onPeerRemoved;
    this.onMessage = onMessage;
    this.onDelivery = onDelivery;
    this.onError = onError;
    this.relay = null;
    this.subscription = null;
    this.relayURL = null;
    this.geohash = "u33dc";
    this.status = "disabled";
    this.peers = new Map();
    this.seenEvents = new Set();
  }

  get connected() {
    return Boolean(this.relay?.connected);
  }

  setNickname(nickname) {
    this.nickname = nickname;
  }

  async connect({ relayURL = DEFAULT_RELAYS[0], geohash = "u33dc" } = {}) {
    const normalizedRelay = normalizeRelayURL(relayURL);
    const normalizedGeohash = String(geohash ?? "").trim().toLowerCase();
    if (!normalizedRelay) throw new Error("URL de relais invalide : utilisez wss://");
    if (!/^[0123456789bcdefghjkmnpqrstuvwxyz]{4,12}$/.test(normalizedGeohash)) {
      throw new Error("Geohash invalide");
    }
    this.disconnect();
    this.relayURL = normalizedRelay;
    this.geohash = normalizedGeohash;
    this.secretKey = readOrCreateSecretKey(
      this.storage,
      `${this.identityStorageKey}:${this.geohash}`
    );
    this.publicKey = getPublicKey(this.secretKey);
    this.#setStatus("connecting");
    try {
      this.relay = await Relay.connect(normalizedRelay, {
        enableReconnect: true,
        idleTimeout: 0
      });
      this.relay.onclose = () => this.#setStatus("disconnected");
      this.relay.onnotice = (notice) => this.onError(new Error(`Relais Nostr : ${notice}`));
      this.subscription = this.relay.subscribe([
        {
          kinds: [
            BitChatNostrContract.publicMessageKind,
            BitChatNostrContract.publicEphemeralKind
          ],
          "#g": [this.geohash],
          since: Math.floor(Date.now() / 1000) - 3_600,
          limit: 200
        },
        {
          kinds: [BitChatNostrContract.privateGiftWrapKind],
          "#p": [this.publicKey],
          since: Math.floor(Date.now() / 1000) - 86_400,
          limit: 100
        }
      ], {
        onevent: (event) => this.#handleEvent(event),
        onclose: () => {
          if (this.status !== "disabled") this.#setStatus("disconnected");
        }
      });
      this.#setStatus("connected");
      await this.publishPresence();
      return { relayURL: normalizedRelay, geohash: this.geohash, publicKey: this.publicKey };
    } catch (error) {
      this.#setStatus("error");
      this.onError(error);
      throw error;
    }
  }

  disconnect() {
    this.subscription?.close("user");
    this.subscription = null;
    this.relay?.close();
    this.relay = null;
    for (const peer of this.peers.values()) this.onPeerRemoved(peer);
    this.peers.clear();
    this.seenEvents.clear();
    this.#setStatus("disabled");
  }

  async publishMessage(content) {
    this.#requireConnection();
    const event = finalizeEvent({
      kind: BitChatNostrContract.publicMessageKind,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["g", this.geohash],
        ["n", this.nickname]
      ],
      content
    }, this.secretKey);
    await this.relay.publish(event);
    return {
      id: `nostr-${event.id}`,
      eventID: event.id,
      timestamp: event.created_at * 1000
    };
  }

  async publishPresence() {
    if (!this.connected) return;
    const event = finalizeEvent({
      kind: BitChatNostrContract.publicEphemeralKind,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["g", this.geohash]],
      content: ""
    }, this.secretKey);
    await this.relay.publish(event);
  }

  async publishPrivateMessage(recipientPublicKey, content) {
    this.#requireConnection();
    const messageID = crypto.randomUUID();
    const giftWrap = await this.#publishPrivateContent(
      recipientPublicKey,
      encodeBitChatNostrPrivateMessage({
        content,
        messageID,
        senderPeerID: this.senderPeerID
      })
    );
    return {
      id: `nostr-${messageID}`,
      eventID: giftWrap.id,
      timestamp: Date.now()
    };
  }

  async publishReadReceipt(recipientPublicKey, messageID) {
    this.#requireConnection();
    await this.#publishMessageReceipt(recipientPublicKey, "readReceipt", messageID);
  }

  #handleEvent(event) {
    if (!event?.id || this.seenEvents.has(event.id)) return;
    this.seenEvents.add(event.id);
    if (this.seenEvents.size > 1_000) this.seenEvents.delete(this.seenEvents.values().next().value);
    if (event.kind === BitChatNostrContract.privateGiftWrapKind) {
      this.#handlePrivateEvent(event).catch((error) => this.onError(error));
      return;
    }
    if (!verifyEvent(event)
      || event.pubkey === this.publicKey
      || tagValue(event, "g") !== this.geohash
      || ![
        BitChatNostrContract.publicMessageKind,
        BitChatNostrContract.publicEphemeralKind
      ].includes(event.kind)) {
      return;
    }
    const existingPeer = this.peers.get(event.pubkey);
    const nickname = InputValidator.validateNickname(tagValue(event, "n"))
      || existingPeer?.nickname
      || `anon#${event.pubkey.slice(0, 4)}`;
    const eventTimestamp = Math.min(event.created_at * 1000, Date.now());
    const peer = {
      id: `nostr-${event.pubkey.slice(0, 16)}`,
      pubkey: event.pubkey,
      nickname,
      transport: "nostr",
      avatarIndex: Number.parseInt(event.pubkey.slice(-2), 16) % 6,
      lastSeen: eventTimestamp
    };
    this.peers.set(event.pubkey, peer);
    this.onPeer(peer);
    if (event.kind === BitChatNostrContract.publicMessageKind && event.content.trim()) {
      this.onMessage({
        id: `nostr-${event.id}`,
        sender: nickname,
        content: event.content,
        timestamp: eventTimestamp,
        authorId: peer.id,
        conversationId: "geo",
        type: "text",
        transport: "nostr",
        acceptHistoricalTimestamp: true
      });
    }
  }

  async #handlePrivateEvent(giftWrap) {
    const opened = openBitChatPrivateEnvelope({
      giftWrap,
      recipientSecretKey: this.secretKey
    });
    const payload = decodeBitChatNostrPayload(opened.content);
    if (!payload) return;
    const existingPeer = this.peers.get(opened.senderPublicKey);
    const peer = {
      id: `nostr-${opened.senderPublicKey.slice(0, 16)}`,
      pubkey: opened.senderPublicKey,
      nickname: existingPeer?.nickname ?? `anon#${opened.senderPublicKey.slice(0, 4)}`,
      transport: "nostr",
      avatarIndex: Number.parseInt(opened.senderPublicKey.slice(-2), 16) % 6,
      lastSeen: opened.timestamp
    };
    this.peers.set(opened.senderPublicKey, peer);
    this.onPeer(peer);
    if (payload.type === "privateMessage") {
      this.onMessage({
        id: `nostr-${payload.id}`,
        transportMessageID: payload.id,
        sender: peer.nickname,
        content: payload.content,
        timestamp: opened.timestamp,
        authorId: peer.id,
        isPrivate: true,
        type: "text",
        transport: "nostr",
        acceptHistoricalTimestamp: true
      });
      await this.#publishMessageReceipt(opened.senderPublicKey, "delivered", payload.id);
      return;
    }
    if (payload.type === "delivered" || payload.type === "readReceipt") {
      this.onDelivery({
        id: `nostr-${payload.messageID}`,
        status: payload.type === "delivered" ? "delivered" : "read",
        transport: "nostr"
      });
    }
  }

  async #publishMessageReceipt(recipientPublicKey, type, messageID) {
    await this.#publishPrivateContent(
      recipientPublicKey,
      encodeBitChatNostrMessageReceipt({
        type,
        messageID,
        senderPeerID: this.senderPeerID
      })
    );
  }

  async #publishPrivateContent(recipientPublicKey, content) {
    this.#requireConnection();
    if (!(this.senderPeerID instanceof Uint8Array) || this.senderPeerID.length !== 8) {
      throw new Error("Identité mesh requise pour le message Nostr privé");
    }
    const giftWrap = createBitChatPrivateEnvelope({
      content,
      recipientPublicKey,
      senderSecretKey: this.secretKey
    });
    await this.relay.publish(giftWrap);
    return giftWrap;
  }

  #requireConnection() {
    if (!this.connected) throw new Error("Le relais Nostr n’est pas connecté");
  }

  #setStatus(status) {
    this.status = status;
    this.onStatus({
      status,
      connected: this.connected,
      relayURL: this.relayURL,
      geohash: this.geohash,
      publicKey: this.publicKey
    });
  }
}

export function isNostrRelayURL(value) {
  return Boolean(normalizeRelayURL(value));
}
