import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  equalBytes,
  randomBytes,
  utf8ToBytes
} from "../../core/bytes.js";
import { InputValidator } from "../../core/input-validator.js";
import {
  BitChatBLE,
  BitChatFragmentAssembler,
  BitChatMessageType,
  BitChatNetwork,
  BitChatNoisePayloadType,
  BitChatNotificationAssembler,
  createSignedAnnouncementPacket,
  createSignedPublicMessagePacket,
  decodeAnnouncement,
  decodeBitChatPacket,
  decodeFileTransferPayload,
  decodeNoisePayload,
  decodePublicMessage,
  encodeAuthenticatedPeerState,
  encodeBitChatPacket,
  encodeFileTransferPayload,
  encodeMessageReceiptPayload,
  encodePrivateMessagePayload,
  isPacketForPeer,
  makeFragmentPackets,
  packetSenderHex,
  peerIDFromNoisePublicKey,
  routingIDFromExternalID,
  signBitChatPacket,
  verifyBitChatPacket
} from "./bit-chat-codec.js";
import { NoiseXXSession } from "./noise-xx.js";
import {
  createDefaultBLEConnector,
  isDefaultBLEConnectorSupported
} from "./ble-radio-link.js";
import {
  acceptsFragmentForRelay,
  acceptsOpaquePacketForRelay
} from "./mesh-relay-policy.js";
import {
  encodeVerifyChallenge,
  encodeVerifyResponse,
  fingerprintForNoiseKey,
  parseAndVerifyResponse,
  parseVerifyChallenge
} from "./identity-verification.js";

const EXTERNAL_ID_PREFIX = "ble-";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function externalID(peerIDHex) {
  return `${EXTERNAL_ID_PREFIX}${peerIDHex}`;
}

function messageIDForPacket(packet, content) {
  const source = utf8ToBytes(`${packetSenderHex(packet)}|${packet.timestamp}|${content.trim()}`);
  return `ble-${bytesToHex(sha256(source).slice(0, 16))}`;
}

function fileMessageID(packet, file) {
  const source = concatBytes(
    packet.senderID,
    utf8ToBytes(`|${packet.timestamp}|${file.fileName}|`),
    file.content
  );
  return `ble-${bytesToHex(sha256(source).slice(0, 16))}`;
}

function bytesToDataURL(content, mimeType) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    binary += String.fromCharCode(...content.subarray(offset, offset + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * Optional Web Bluetooth central adapter for BitChat's native BLE service.
 *
 * The browser cannot advertise the BitChat service, so this adapter is one
 * GATT central link into the native mesh rather than a replacement mesh node.
 */
export class WebBluetoothMeshAdapter {
  constructor({
    identity,
    nickname,
    onStatus = () => {},
    onPeer = () => {},
    onPeerRemoved = () => {},
    onMessage = () => {},
    onDelivery = () => {},
    onVerification = () => {},
    onError = () => {},
    connector = createDefaultBLEConnector()
  }) {
    this.identity = identity;
    this.nickname = nickname;
    this.onStatus = onStatus;
    this.onPeer = onPeer;
    this.onPeerRemoved = onPeerRemoved;
    this.onMessage = onMessage;
    this.onDelivery = onDelivery;
    this.onVerification = onVerification;
    this.onError = onError;
    this.connector = connector;
    this.link = null;
    this.network = BitChatNetwork.mainnet;
    this.notificationAssembler = new BitChatNotificationAssembler();
    this.fragmentAssembler = new BitChatFragmentAssembler();
    this.peers = new Map();
    this.sessions = new Map();
    this.pendingPrivateMessages = new Map();
    this.pendingVerifications = new Map();
    this.seenPackets = new Set();
    this.writeQueue = Promise.resolve();
    this.receiveQueue = Promise.resolve();
    this.status = "disabled";
  }

  static get isSupported() {
    return isDefaultBLEConnectorSupported();
  }

  get connected() {
    return Boolean(this.link?.connected);
  }

  get canTransmit() {
    return Boolean(this.link?.connected && (this.link.canTransmit ?? true));
  }

  setNickname(nickname) {
    this.nickname = nickname;
    if (this.connected) return this.#sendAnnouncement();
    return Promise.resolve();
  }

  async connect({ network = "mainnet" } = {}) {
    if (!this.connector) {
      this.#setStatus("unsupported");
      throw new Error("Web Bluetooth n’est pas disponible dans ce navigateur");
    }
    this.network = BitChatNetwork[network] ?? BitChatNetwork.mainnet;
    this.#setStatus("connecting");
    try {
      this.link = await this.connector.connect({
        preferredNetwork: this.network,
        networks: BitChatNetwork,
        characteristicUUID: BitChatBLE.characteristicUUID
      });
      this.network = this.link.network ?? this.network;
      this.link.addEventListener("disconnect", this.#handleDisconnect);
      this.link.addEventListener("data", this.#handleNotification);
      this.link.addEventListener("peeravailable", this.#handlePeerAvailable);
      this.link.addEventListener("subscriberchange", this.#handleSubscriberChange);
      this.link.addEventListener("error", this.#handleLinkError);
      await this.link.start();
      this.#setStatus("connected");
      if (this.canTransmit) await this.#sendAnnouncement();
      return {
        deviceName: this.link.name,
        network: this.network.id
      };
    } catch (error) {
      this.#setStatus(error?.name === "NotFoundError" ? "disabled" : "error");
      this.onError(error);
      throw error;
    }
  }

  disconnect() {
    this.link?.removeEventListener("disconnect", this.#handleDisconnect);
    this.link?.removeEventListener("data", this.#handleNotification);
    this.link?.removeEventListener("peeravailable", this.#handlePeerAvailable);
    this.link?.removeEventListener("subscriberchange", this.#handleSubscriberChange);
    this.link?.removeEventListener("error", this.#handleLinkError);
    this.link?.close();
    this.link = null;
    this.sessions.clear();
    this.pendingPrivateMessages.clear();
    this.pendingVerifications.clear();
    this.seenPackets.clear();
    for (const peer of this.peers.values()) this.onPeerRemoved(peer);
    this.peers.clear();
    this.#setStatus("disabled");
  }

  async sendPublicMessage(content) {
    this.#requireConnection();
    const packet = createSignedPublicMessagePacket(this.identity, content);
    await this.#sendPacket(packet);
    return {
      id: messageIDForPacket(packet, content),
      timestamp: packet.timestamp
    };
  }

  async sendPrivateMessage(peerExternalID, content, messageID = crypto.randomUUID()) {
    this.#requireConnection();
    const pending = await this.#sendOrQueuePrivate(peerExternalID, {
      kind: "message",
      id: messageID,
      content
    });
    return { id: messageID, timestamp: Date.now(), pending };
  }

  async sendFile(peerExternalID, file) {
    this.#requireConnection();
    const payload = encodeFileTransferPayload(file);
    const id = crypto.randomUUID();
    if (peerExternalID) {
      const pending = await this.#sendOrQueuePrivate(peerExternalID, {
        kind: "file",
        id,
        payload
      });
      return { id, timestamp: Date.now(), pending };
    }

    const timestamp = Date.now();
    const packet = signBitChatPacket({
      version: payload.length > 0xffff ? 2 : 1,
      type: BitChatMessageType.fileTransfer,
      ttl: BitChatBLE.defaultTTL,
      timestamp,
      senderID: this.identity.peerID,
      recipientID: null,
      payload,
      signature: null
    }, this.identity.signingSecretKey);
    await this.#sendPacket(packet);
    return { id: fileMessageID(packet, file), timestamp };
  }

  async sendReadReceipt(peerExternalID, messageID) {
    this.#requireConnection();
    const recipientID = routingIDFromExternalID(peerExternalID);
    if (recipientID?.length !== 8) throw new Error("Identité Bluetooth destinataire invalide");
    const peerIDHex = bytesToHex(recipientID);
    if (this.sessions.get(peerIDHex)?.state !== "established") {
      throw new Error("La session Noise n’est pas établie");
    }
    await this.#sendEncrypted(
      peerIDHex,
      encodeMessageReceiptPayload("readReceipt", messageID)
    );
  }

  async verifyScannedIdentity(qr) {
    this.#requireConnection();
    const peerEntry = [...this.peers.entries()].find(([, peer]) => (
      bytesToHex(peer.noisePublicKey) === qr?.noiseKeyHex?.toLowerCase()
    ));
    if (!peerEntry) {
      throw new Error("Cette identité QR n’est pas actuellement à portée Bluetooth");
    }
    const [peerIDHex, peer] = peerEntry;
    if (bytesToHex(peer.signingPublicKey) !== qr.signKeyHex.toLowerCase()) {
      throw new Error("La clé de signature QR ne correspond pas au pair Bluetooth");
    }
    const pending = {
      noiseKeyHex: qr.noiseKeyHex.toLowerCase(),
      signingPublicKey: peer.signingPublicKey.slice(),
      nonce: randomBytes(16),
      createdAt: Date.now()
    };
    this.pendingVerifications.set(peerIDHex, pending);
    await this.#sendOrQueuePrivate(peer.id, { kind: "verification", pending });
    return { peerID: peer.id, nickname: peer.nickname };
  }

  async #sendOrQueuePrivate(peerExternalID, item) {
    const recipientID = routingIDFromExternalID(peerExternalID);
    if (recipientID?.length !== 8) throw new Error("Identité Bluetooth destinataire invalide");
    const peerIDHex = bytesToHex(recipientID);
    if (!this.peers.has(peerIDHex)) throw new Error("Ce pair BitChat n’est plus joignable");
    const session = this.sessions.get(peerIDHex);
    if (session?.state === "established") {
      await this.#sendPendingPrivate(peerIDHex, item);
      return false;
    }

    const pending = this.pendingPrivateMessages.get(peerIDHex) ?? [];
    pending.push(item);
    this.pendingPrivateMessages.set(peerIDHex, pending);
    if (!session || session.state === "uninitialized") {
      const initiator = new NoiseXXSession({
        role: "initiator",
        localStaticSecret: this.identity.noiseSecretKey
      });
      this.sessions.set(peerIDHex, initiator);
      await this.#sendHandshake(peerIDHex, initiator.start());
    }
    return true;
  }

  async #sendPendingPrivate(peerIDHex, item) {
    if (item.kind === "verification") {
      await this.#sendEncrypted(
        peerIDHex,
        encodeVerifyChallenge(item.pending.noiseKeyHex, item.pending.nonce)
      );
      return;
    }
    if (item.kind === "file") {
      await this.#sendEncrypted(
        peerIDHex,
        concatBytes(Uint8Array.of(BitChatNoisePayloadType.privateFile), item.payload)
      );
      return;
    }
    await this.#sendPrivatePayload(peerIDHex, item.id, item.content);
  }

  #handleDisconnect = () => {
    const removedPeers = [...this.peers.values()];
    this.link = null;
    this.sessions.clear();
    this.pendingPrivateMessages.clear();
    this.pendingVerifications.clear();
    this.peers.clear();
    removedPeers.forEach((peer) => this.onPeerRemoved(peer));
    this.#setStatus("disconnected");
  };

  #handlePeerAvailable = () => {
    this.#sendAnnouncement().catch((error) => this.onError(error));
  };

  #handleSubscriberChange = (event) => {
    this.#publishStatus();
    if (Number(event.detail?.count) > 0) {
      this.#sendAnnouncement().catch((error) => this.onError(error));
    }
  };

  #handleLinkError = (event) => {
    this.onError(event.detail ?? new Error("Erreur radio Bluetooth Windows"));
  };

  #handleNotification = (event) => {
    const chunk = event.detail;
    if (!(chunk instanceof Uint8Array)) return;
    for (const frame of this.notificationAssembler.append(chunk)) {
      const decoded = decodeBitChatPacket(frame);
      if (!decoded) continue;
      this.receiveQueue = this.receiveQueue
        .then(() => this.#handleFrame(decoded))
        .catch((error) => this.onError(error));
    }
  };

  async #handleFrame(packet) {
    const packetKey = this.#packetKey(packet);
    if (this.seenPackets.has(packetKey)) return;
    this.seenPackets.add(packetKey);
    if (this.seenPackets.size > 2_048) this.seenPackets.delete(this.seenPackets.values().next().value);
    if (Math.abs(Date.now() - packet.timestamp) > 5 * 60 * 1000 && !packet.isRSR) return;

    if (packet.type === BitChatMessageType.fragment) {
      if (!acceptsFragmentForRelay(packet, this.peers.get(packetSenderHex(packet)))) return;
      this.#scheduleRelay(packet);
      const assembled = this.fragmentAssembler.append(packet);
      if (assembled) await this.#handlePacket(assembled);
      return;
    }
    const accepted = await this.#handlePacket(packet);
    if (accepted) this.#scheduleRelay(packet);
  }

  async #handlePacket(packet) {
    const senderIDHex = packetSenderHex(packet);
    if (senderIDHex === this.identity.peerIDHex) return false;

    switch (packet.type) {
      case BitChatMessageType.announce:
        return this.#handleAnnouncement(packet, senderIDHex);
      case BitChatMessageType.message:
        return this.#handlePublicMessage(packet, senderIDHex);
      case BitChatMessageType.fileTransfer:
        return this.#handleFileTransfer(packet, senderIDHex);
      case BitChatMessageType.leave:
        return this.#handleLeave(packet, senderIDHex);
      case BitChatMessageType.noiseHandshake:
        if (!isPacketForPeer(packet, this.identity.peerID)) return true;
        await this.#handleHandshake(packet, senderIDHex);
        return true;
      case BitChatMessageType.noiseEncrypted:
        if (!isPacketForPeer(packet, this.identity.peerID)) return true;
        await this.#handleEncrypted(packet, senderIDHex);
        return true;
      default:
        return acceptsOpaquePacketForRelay(packet, this.peers.get(senderIDHex));
    }
  }

  #handleAnnouncement(packet, senderIDHex) {
    const announcement = decodeAnnouncement(packet.payload);
    if (!announcement) return false;
    const nickname = InputValidator.validateNickname(announcement.nickname);
    if (!nickname) return false;
    if (!equalBytes(peerIDFromNoisePublicKey(announcement.noisePublicKey), packet.senderID)) return false;
    if (!verifyBitChatPacket(packet, announcement.signingPublicKey)) return false;
    const existing = this.peers.get(senderIDHex);
    if (existing && !equalBytes(existing.signingPublicKey, announcement.signingPublicKey)) return false;

    const peer = {
      id: externalID(senderIDHex),
      peerIDHex: senderIDHex,
      nickname,
      noisePublicKey: announcement.noisePublicKey,
      signingPublicKey: announcement.signingPublicKey,
      fingerprint: fingerprintForNoiseKey(announcement.noisePublicKey),
      transport: "bluetooth",
      avatarIndex: Number.parseInt(senderIDHex.slice(-2), 16) % 6
    };
    this.peers.set(senderIDHex, peer);
    this.onPeer(peer);
    return true;
  }

  #handlePublicMessage(packet, senderIDHex) {
    const peer = this.peers.get(senderIDHex);
    const content = decodePublicMessage(packet);
    if (!peer || !content || !verifyBitChatPacket(packet, peer.signingPublicKey)) return false;
    this.onMessage({
      id: messageIDForPacket(packet, content),
      sender: peer.nickname,
      content,
      timestamp: packet.timestamp,
      authorId: peer.id,
      conversationId: "mesh",
      type: "text",
      transport: "bluetooth"
    });
    return true;
  }

  #handleFileTransfer(packet, senderIDHex) {
    if (packet.recipientID && !isPacketForPeer(packet, this.identity.peerID)) return true;
    const peer = this.peers.get(senderIDHex);
    if (!peer || !verifyBitChatPacket(packet, peer.signingPublicKey)) return false;
    const file = decodeFileTransferPayload(packet.payload);
    if (!file) return false;
    this.#emitFileMessage(packet, peer, file, Boolean(packet.recipientID), "bluetooth");
    return true;
  }

  #handleLeave(packet, senderIDHex) {
    const peer = this.peers.get(senderIDHex);
    if (!peer || !verifyBitChatPacket(packet, peer.signingPublicKey)) return false;
    this.#removePeer(senderIDHex);
    return true;
  }

  async #handleHandshake(packet, senderIDHex) {
    if (!isPacketForPeer(packet, this.identity.peerID) || !this.peers.has(senderIDHex)) return;
    let session = this.sessions.get(senderIDHex);
    // Native BitChat resolves crossed XX initiations lexicographically: the
    // lower peer ID keeps the initiator role, the higher one yields.
    const crossedInitiation = packet.payload.length === 32 && session?.role === "initiator";
    if (crossedInitiation && this.identity.peerIDHex < senderIDHex) return;
    if (!session || crossedInitiation) {
      session = new NoiseXXSession({
        role: "responder",
        localStaticSecret: this.identity.noiseSecretKey
      });
      this.sessions.set(senderIDHex, session);
    }
    const response = session.process(packet.payload);
    if (response) await this.#sendHandshake(senderIDHex, response);
    if (session.state === "established") await this.#promoteSession(senderIDHex, session);
  }

  async #handleEncrypted(packet, senderIDHex) {
    if (!isPacketForPeer(packet, this.identity.peerID)) return;
    const session = this.sessions.get(senderIDHex);
    const peer = this.peers.get(senderIDHex);
    if (session?.state !== "established" || !peer) return;
    const plaintext = session.decrypt(packet.payload);
    const payload = decodeNoisePayload(plaintext);
    if (!payload) return;
    if (payload.type === "privateMessage") {
      this.onMessage({
        id: payload.id,
        transportMessageID: payload.id,
        sender: peer.nickname,
        content: payload.content,
        timestamp: packet.timestamp,
        authorId: peer.id,
        conversationId: null,
        type: "text",
        isPrivate: true,
        transport: "noise"
      });
      await this.#sendEncrypted(
        senderIDHex,
        encodeMessageReceiptPayload("delivered", payload.id)
      );
      return;
    }
    if (payload.type === "delivered" || payload.type === "readReceipt") {
      this.onDelivery({
        id: payload.messageID,
        status: payload.type === "delivered" ? "delivered" : "read",
        transport: "noise"
      });
      return;
    }
    if (payload.type === "privateFile") {
      this.#emitFileMessage(packet, peer, payload.file, true, "noise");
      return;
    }
    if (payload.type === "verifyChallenge") {
      const challenge = parseVerifyChallenge(payload.data);
      if (!challenge || challenge.noiseKeyHex !== bytesToHex(this.identity.noisePublicKey)) return;
      await this.#sendEncrypted(
        senderIDHex,
        encodeVerifyResponse(this.identity, challenge.noiseKeyHex, challenge.nonce)
      );
      return;
    }
    if (payload.type === "verifyResponse") {
      const pending = this.pendingVerifications.get(senderIDHex);
      if (!pending || Date.now() - pending.createdAt > 5 * 60 * 1_000) {
        this.pendingVerifications.delete(senderIDHex);
        return;
      }
      const response = parseAndVerifyResponse(payload.data, pending.signingPublicKey);
      if (!response
        || response.noiseKeyHex !== pending.noiseKeyHex
        || !equalBytes(response.nonce, pending.nonce)) return;
      this.pendingVerifications.delete(senderIDHex);
      peer.verified = true;
      this.onPeer(peer);
      this.onVerification({
        peer,
        fingerprint: peer.fingerprint,
        verified: true
      });
    }
  }

  #emitFileMessage(packet, peer, file, isPrivate, transport) {
    const isImage = file.mimeType.startsWith("image/");
    const isAudio = file.mimeType.startsWith("audio/");
    const dataURL = bytesToDataURL(file.content, file.mimeType);
    this.onMessage({
      id: fileMessageID(packet, file),
      sender: peer.nickname,
      content: file.fileName,
      timestamp: packet.timestamp,
      authorId: peer.id,
      conversationId: isPrivate ? null : "mesh",
      type: isImage ? "image" : isAudio ? "voice" : "file",
      image: isImage ? dataURL : null,
      audio: isAudio ? dataURL : null,
      fileData: !isImage && !isAudio ? dataURL : null,
      fileName: file.fileName,
      mimeType: file.mimeType,
      isPrivate,
      supportsReceipts: false,
      transport
    });
  }

  async #promoteSession(senderIDHex, session) {
    const peer = this.peers.get(senderIDHex);
    if (!peer
      || !session.remoteStaticPublic
      || !equalBytes(peerIDFromNoisePublicKey(session.remoteStaticPublic), packetID(senderIDHex))) {
      this.sessions.delete(senderIDHex);
      this.pendingPrivateMessages.delete(senderIDHex);
      throw new Error("L’identité Noise du pair ne correspond pas à son identité mesh");
    }
    peer.noiseState = "established";
    this.onPeer(peer);
    await this.#sendEncrypted(senderIDHex, encodeAuthenticatedPeerState(this.identity.signingPublicKey));
    const pending = this.pendingPrivateMessages.get(senderIDHex) ?? [];
    this.pendingPrivateMessages.delete(senderIDHex);
    for (const item of pending) {
      await this.#sendPendingPrivate(senderIDHex, item);
    }
  }

  async #sendAnnouncement() {
    await this.#sendPacket(createSignedAnnouncementPacket(
      this.identity,
      this.nickname
    ));
  }

  async #sendHandshake(recipientIDHex, payload) {
    await this.#sendPacket({
      version: 1,
      type: BitChatMessageType.noiseHandshake,
      ttl: BitChatBLE.defaultTTL,
      timestamp: Date.now(),
      senderID: this.identity.peerID,
      recipientID: packetID(recipientIDHex),
      payload,
      signature: null
    });
  }

  async #sendPrivatePayload(recipientIDHex, messageID, content) {
    await this.#sendEncrypted(
      recipientIDHex,
      encodePrivateMessagePayload(messageID, content)
    );
  }

  async #sendEncrypted(recipientIDHex, typedPayload) {
    const session = this.sessions.get(recipientIDHex);
    if (session?.state !== "established") throw new Error("La session Noise n’est pas établie");
    const encryptedPayload = session.encrypt(typedPayload);
    await this.#sendPacket({
      version: encryptedPayload.length > 0xffff ? 2 : 1,
      type: BitChatMessageType.noiseEncrypted,
      ttl: BitChatBLE.defaultTTL,
      timestamp: Date.now(),
      senderID: this.identity.peerID,
      recipientID: packetID(recipientIDHex),
      payload: encryptedPayload,
      signature: null
    });
  }

  async #sendPacket(packet) {
    this.#requireConnection();
    const fragments = makeFragmentPackets(packet);
    for (let index = 0; index < fragments.length; index += 1) {
      const fragment = fragments[index];
      const padding = fragment.type === BitChatMessageType.noiseHandshake
        || fragment.type === BitChatMessageType.noiseEncrypted;
      await this.#write(encodeBitChatPacket(fragment, { padding }));
      const delayMilliseconds = this.link?.fragmentDelayMilliseconds ?? 25;
      if (delayMilliseconds > 0 && fragments.length > 1 && index < fragments.length - 1) {
        await wait(delayMilliseconds);
      }
    }
  }

  #write(bytes) {
    const write = async () => {
      this.#requireConnection();
      if (!this.canTransmit) {
        throw new Error("Aucun appareil BitChat n’est actuellement connecté au transport Bluetooth");
      }
      await this.link.write(bytes);
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }

  #packetKey(packet) {
    return bytesToHex(sha256(encodeBitChatPacket(packet)).slice(0, 16));
  }

  #scheduleRelay(packet) {
    if (!this.link?.supportsMultiplePeers
      || packet.ttl <= 1
      || packetSenderHex(packet) === this.identity.peerIDHex
      || isPacketForPeer(packet, this.identity.peerID)) {
      return;
    }
    const relayed = { ...packet, ttl: Math.min(packet.ttl, BitChatBLE.defaultTTL) - 1 };
    const delayMilliseconds = 10 + Math.floor(Math.random() * 31);
    setTimeout(() => {
      if (this.canTransmit) this.#sendPacket(relayed).catch((error) => this.onError(error));
    }, delayMilliseconds);
  }

  #removePeer(peerIDHex) {
    const peer = this.peers.get(peerIDHex);
    if (!peer) return;
    this.peers.delete(peerIDHex);
    this.sessions.delete(peerIDHex);
    this.pendingPrivateMessages.delete(peerIDHex);
    this.pendingVerifications.delete(peerIDHex);
    this.onPeerRemoved(peer);
  }

  #requireConnection() {
    if (!this.connected) throw new Error("Bluetooth BitChat n’est pas connecté");
  }

  #setStatus(status) {
    this.status = status;
    this.#publishStatus();
  }

  #publishStatus() {
    this.onStatus({
      status: this.status,
      connected: this.connected,
      canTransmit: this.canTransmit,
      deviceName: this.link?.name ?? null,
      network: this.network.id,
      peerCount: this.link?.peerCount ?? (this.connected ? 1 : 0)
    });
  }
}

function packetID(peerIDHex) {
  const bytes = routingIDFromExternalID(externalID(peerIDHex));
  if (bytes?.length !== 8) throw new Error("Invalid BitChat routing ID");
  return bytes;
}
