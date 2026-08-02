import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { zlibSync } from "fflate";
import { getPublicKey } from "nostr-tools/pure";
import {
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
  writeUint16BE
} from "../src/core/bytes.js";
import {
  BitChatFragmentAssembler,
  BitChatMessageType,
  BitChatNotificationAssembler,
  createSignedAnnouncementPacket,
  createSignedPublicMessagePacket,
  decodeAnnouncement,
  decodeBitChatPacket,
  decodeFileTransferPayload,
  decodeNoisePayload,
  decodePrivateMessagePayload,
  encodeBitChatPacket,
  encodeFileTransferPayload,
  encodeMessageReceiptPayload,
  encodePrivateMessagePayload,
  makeFragmentPackets,
  peerIDFromNoisePublicKey,
  signBitChatPacket,
  verifyBitChatPacket
} from "../src/features/native-connectivity/bit-chat-codec.js";
import { isNostrRelayURL } from "../src/features/native-connectivity/nostr-geohash-adapter.js";
import {
  NoiseXXHandshake,
  NoiseXXSession
} from "../src/features/native-connectivity/noise-xx.js";
import {
  createBitChatPrivateEnvelope,
  decodeBitChatNostrPayload,
  decodeBitChatNostrPrivateMessage,
  encodeBitChatNostrMessageReceipt,
  encodeBitChatNostrPrivateMessage,
  openBitChatPrivateEnvelope
} from "../src/features/native-connectivity/bit-chat-nostr-envelope.js";
import { WebBluetoothMeshAdapter } from "../src/features/native-connectivity/web-bluetooth-mesh-adapter.js";
import { loadMeshIdentity } from "../src/features/native-connectivity/browser-mesh-identity.js";
import {
  buildVerificationQR,
  encodeVerifyChallenge,
  encodeVerifyResponse,
  parseAndVerifyResponse,
  parseAndVerifyVerificationQR,
  parseVerifyChallenge
} from "../src/features/native-connectivity/identity-verification.js";

const vectorsURL = new URL("../../bitchatTests/Noise/NoiseTestVectors.json", import.meta.url);
const noiseVectors = JSON.parse(await readFile(vectorsURL, "utf8"));
const nostrFixturesURL = new URL("../../bitchatTests/Nostr/Fixtures/", import.meta.url);

async function waitForCondition(predicate, description, timeoutMilliseconds = 2_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test("Desktop mesh identity comes from the protected platform port", async () => {
  const noiseSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const signingSecretKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  let storageWrites = 0;
  const identity = await loadMeshIdentity({
    desktopIdentity: {
      async loadOrCreate() {
        return {
          scheme: "dpapi-current-user-v1",
          noiseSecretKey: Buffer.from(noiseSecretKey).toString("base64"),
          signingSecretKey: Buffer.from(signingSecretKey).toString("base64")
        };
      }
    },
    storage: {
      getItem: () => null,
      setItem: () => { storageWrites += 1; }
    }
  });
  assert.deepEqual(identity.noiseSecretKey, noiseSecretKey);
  assert.deepEqual(identity.signingSecretKey, signingSecretKey);
  assert.equal(storageWrites, 0);
});

test("Desktop QR verification uses Android's signed bitchat://verify contract", () => {
  const noiseSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const signingSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
  const identity = {
    noisePublicKey: x25519.getPublicKey(noiseSecretKey),
    signingPublicKey: ed25519.getPublicKey(signingSecretKey),
    signingSecretKey
  };
  const timestampSeconds = 1_750_000_000;
  const nonce = Uint8Array.from({ length: 16 }, (_, index) => index);
  const value = buildVerificationQR({
    identity,
    nickname: "Desktop",
    timestampSeconds,
    nonce
  });
  const parsed = parseAndVerifyVerificationQR(value, { nowSeconds: timestampSeconds + 10 });
  assert.equal(parsed.nickname, "Desktop");
  assert.equal(parsed.noiseKeyHex, bytesToHex(identity.noisePublicKey));
  assert.equal(parsed.signKeyHex, bytesToHex(identity.signingPublicKey));
  assert.equal(
    parseAndVerifyVerificationQR(value, { nowSeconds: timestampSeconds + 301 }),
    null
  );
  const tampered = value.replace("nick=Desktop", "nick=Intrus");
  assert.equal(parseAndVerifyVerificationQR(tampered, { nowSeconds: timestampSeconds }), null);
});

test("QR challenge and response match Android's Noise verification TLV", () => {
  const signingSecretKey = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
  const identity = {
    signingSecretKey,
    signingPublicKey: ed25519.getPublicKey(signingSecretKey)
  };
  const noiseKeyHex = "42".repeat(32);
  const nonce = Uint8Array.from({ length: 16 }, (_, index) => 15 - index);
  const challengePayload = decodeNoisePayload(encodeVerifyChallenge(noiseKeyHex, nonce));
  assert.equal(challengePayload.type, "verifyChallenge");
  const challenge = parseVerifyChallenge(challengePayload.data);
  assert.equal(challenge.noiseKeyHex, noiseKeyHex);
  assert.deepEqual(challenge.nonce, nonce);

  const responsePayload = decodeNoisePayload(encodeVerifyResponse(identity, noiseKeyHex, nonce));
  assert.equal(responsePayload.type, "verifyResponse");
  assert.deepEqual(
    parseAndVerifyResponse(responsePayload.data, identity.signingPublicKey),
    { noiseKeyHex, nonce }
  );
});

test("Noise XX matches every native BitChat test vector byte-for-byte", () => {
  for (const vector of noiseVectors) {
    const initiator = new NoiseXXHandshake({
      role: "initiator",
      localStaticSecret: hexToBytes(vector.init_static),
      prologue: hexToBytes(vector.init_prologue),
      ephemeralSecret: hexToBytes(vector.init_ephemeral)
    });
    const responder = new NoiseXXHandshake({
      role: "responder",
      localStaticSecret: hexToBytes(vector.resp_static),
      prologue: hexToBytes(vector.resp_prologue),
      ephemeralSecret: hexToBytes(vector.resp_ephemeral)
    });

    const first = initiator.writeMessage(hexToBytes(vector.messages[0].payload));
    assert.equal(bytesToHex(first), vector.messages[0].ciphertext);
    assert.equal(bytesToHex(responder.readMessage(first)), vector.messages[0].payload);

    const second = responder.writeMessage(hexToBytes(vector.messages[1].payload));
    assert.equal(bytesToHex(second), vector.messages[1].ciphertext);
    assert.equal(bytesToHex(initiator.readMessage(second)), vector.messages[1].payload);

    const third = initiator.writeMessage(hexToBytes(vector.messages[2].payload));
    assert.equal(bytesToHex(third), vector.messages[2].ciphertext);
    assert.equal(bytesToHex(responder.readMessage(third)), vector.messages[2].payload);
    assert.equal(bytesToHex(initiator.symmetric.hash), bytesToHex(responder.symmetric.hash));
    if (vector.handshake_hash) assert.equal(bytesToHex(initiator.symmetric.hash), vector.handshake_hash);

    const initiatorTransport = initiator.transportCiphers({ extractedNonce: false });
    const responderTransport = responder.transportCiphers({ extractedNonce: false });
    vector.messages.slice(3).forEach((message, index) => {
      const sender = index % 2 === 0 ? responderTransport.send : initiatorTransport.send;
      const receiver = index % 2 === 0 ? initiatorTransport.receive : responderTransport.receive;
      const plaintext = hexToBytes(message.payload);
      const ciphertext = sender.encrypt(plaintext);
      assert.equal(bytesToHex(ciphertext), message.ciphertext);
      assert.equal(bytesToHex(receiver.decrypt(ciphertext)), message.payload);
    });
  }
});

test("BitChat transport nonces survive loss and reject replay", () => {
  const initiator = new NoiseXXSession({
    role: "initiator",
    localStaticSecret: randomBytes(32)
  });
  const responder = new NoiseXXSession({
    role: "responder",
    localStaticSecret: randomBytes(32)
  });
  const message1 = initiator.start();
  const message2 = responder.process(message1);
  const message3 = initiator.process(message2);
  responder.process(message3);

  const lost = initiator.encrypt(utf8ToBytes("lost"));
  const delivered = initiator.encrypt(utf8ToBytes("delivered"));
  assert.notEqual(bytesToHex(lost.slice(0, 4)), bytesToHex(delivered.slice(0, 4)));
  assert.equal(bytesToUtf8(responder.decrypt(delivered)), "delivered");
  assert.throws(() => responder.decrypt(delivered), /replay/i);
});

test("signed announce and public packets use the native binary contract", () => {
  const noiseSecretKey = x25519.utils.randomSecretKey();
  const signingSecretKey = ed25519.utils.randomSecretKey();
  const identity = {
    noiseSecretKey,
    noisePublicKey: x25519.getPublicKey(noiseSecretKey),
    signingSecretKey,
    signingPublicKey: ed25519.getPublicKey(signingSecretKey)
  };
  identity.peerID = peerIDFromNoisePublicKey(identity.noisePublicKey);

  const announce = createSignedAnnouncementPacket(identity, "web-peer", 1_700_000_000_000);
  const decodedAnnounce = decodeBitChatPacket(encodeBitChatPacket(announce));
  assert.equal(decodedAnnounce.type, BitChatMessageType.announce);
  assert.equal(decodeAnnouncement(decodedAnnounce.payload).nickname, "web-peer");
  assert.equal(verifyBitChatPacket(decodedAnnounce, identity.signingPublicKey), true);

  const message = createSignedPublicMessagePacket(identity, "bonjour mesh", 1_700_000_000_001);
  const decodedMessage = decodeBitChatPacket(encodeBitChatPacket(message));
  assert.equal(bytesToUtf8(decodedMessage.payload), "bonjour mesh");
  assert.equal(verifyBitChatPacket(decodedMessage, identity.signingPublicKey), true);
  decodedMessage.payload[0] ^= 0xff;
  assert.equal(verifyBitChatPacket(decodedMessage, identity.signingPublicKey), false);
});

test("BLE stream and fragment assemblers rebuild a large native packet", () => {
  const packet = {
    version: 1,
    type: BitChatMessageType.message,
    ttl: 7,
    timestamp: Date.now(),
    senderID: randomBytes(8),
    recipientID: null,
    payload: utf8ToBytes("x".repeat(1_400)),
    signature: null
  };
  const fragments = makeFragmentPackets(packet, 220);
  assert.ok(fragments.length > 1);

  const stream = new BitChatNotificationAssembler();
  const fragmentAssembler = new BitChatFragmentAssembler();
  let result = null;
  for (const fragment of fragments) {
    const frame = encodeBitChatPacket(fragment);
    const split = Math.floor(frame.length / 2);
    const frames = [
      ...stream.append(frame.slice(0, split)),
      ...stream.append(frame.slice(split))
    ];
    assert.equal(frames.length, 1);
    result = fragmentAssembler.append(decodeBitChatPacket(frames[0])) ?? result;
  }
  assert.equal(bytesToUtf8(result.payload), "x".repeat(1_400));
});

test("the reusable mesh engine relays verified packets over a multi-peer radio link", async () => {
  class FakeMultiPeerLink extends EventTarget {
    constructor() {
      super();
      this.connected = true;
      this.name = "test radio";
      this.network = { id: "testnet", serviceUUID: "test" };
      this.supportsMultiplePeers = true;
      this.writes = [];
    }

    async start() {}
    async write(bytes) { this.writes.push(bytes.slice()); }
    close() { this.connected = false; }
    receive(bytes) {
      const event = new Event("data");
      Object.defineProperty(event, "detail", { value: bytes });
      this.dispatchEvent(event);
    }
  }

  function identity() {
    const noiseSecretKey = x25519.utils.randomSecretKey();
    const signingSecretKey = ed25519.utils.randomSecretKey();
    const noisePublicKey = x25519.getPublicKey(noiseSecretKey);
    const peerID = peerIDFromNoisePublicKey(noisePublicKey);
    return {
      noiseSecretKey,
      noisePublicKey,
      signingSecretKey,
      signingPublicKey: ed25519.getPublicKey(signingSecretKey),
      peerID,
      peerIDHex: bytesToHex(peerID)
    };
  }

  const link = new FakeMultiPeerLink();
  const localIdentity = identity();
  const remoteIdentity = identity();
  const received = [];
  const adapter = new WebBluetoothMeshAdapter({
    identity: localIdentity,
    nickname: "desktop",
    connector: { connect: async () => link },
    onMessage: (message) => received.push(message)
  });
  await adapter.connect({ network: "testnet" });
  const timestamp = Date.now();
  const announce = createSignedAnnouncementPacket(remoteIdentity, "phone", timestamp);
  link.receive(encodeBitChatPacket(announce));
  const message = createSignedPublicMessagePacket(remoteIdentity, "relayed", timestamp + 1);
  link.receive(encodeBitChatPacket(message));
  const image = signBitChatPacket({
    version: 1,
    type: BitChatMessageType.fileTransfer,
    ttl: 7,
    timestamp: timestamp + 2,
    senderID: remoteIdentity.peerID,
    recipientID: null,
    payload: encodeFileTransferPayload({
      fileName: "mesh.png",
      mimeType: "image/png",
      content: Uint8Array.of(0x89, 0x50, 0x4e, 0x47)
    }),
    signature: null
  }, remoteIdentity.signingSecretKey);
  link.receive(encodeBitChatPacket(image));
  const groupMessage = {
    version: 1,
    type: BitChatMessageType.groupMessage,
    ttl: 7,
    timestamp: timestamp + 3,
    senderID: remoteIdentity.peerID,
    recipientID: null,
    payload: randomBytes(48),
    signature: null
  };
  link.receive(encodeBitChatPacket(groupMessage));
  link.receive(encodeBitChatPacket({
    ...groupMessage,
    type: BitChatMessageType.requestSync,
    timestamp: timestamp + 4
  }));
  await waitForCondition(
    () => received.length === 2 && link.writes.some((frame) => {
      const packet = decodeBitChatPacket(frame);
      return packet?.type === BitChatMessageType.groupMessage && packet.ttl === 6;
    }),
    "the verified multi-peer relay"
  );

  assert.equal(received.length, 2);
  assert.equal(received[0].content, "relayed");
  assert.equal(received[1].type, "image");
  assert.equal(received[1].fileName, "mesh.png");
  assert.match(received[1].image, /^data:image\/png;base64,/);
  const relayed = link.writes
    .map((frame) => decodeBitChatPacket(frame))
    .filter((packet) => bytesToHex(packet.senderID) === remoteIdentity.peerIDHex);
  assert.ok(relayed.some((packet) => packet.type === BitChatMessageType.announce && packet.ttl === 6));
  assert.ok(relayed.some((packet) => packet.type === BitChatMessageType.message && packet.ttl === 6));
  assert.ok(relayed.some((packet) => packet.type === BitChatMessageType.groupMessage && packet.ttl === 6));
  assert.ok(!relayed.some((packet) => packet.type === BitChatMessageType.requestSync));
  adapter.disconnect();
});

test("the Windows-style mesh link waits for a real GATT subscriber before sending", async () => {
  class FakePeripheralLink extends EventTarget {
    constructor() {
      super();
      this.connected = true;
      this.canTransmit = false;
      this.peerCount = 0;
      this.name = "Windows test radio";
      this.network = { id: "mainnet", serviceUUID: "test" };
      this.supportsMultiplePeers = true;
      this.fragmentDelayMilliseconds = 0;
      this.writes = [];
    }

    async start() {}
    async write(bytes) { this.writes.push(bytes.slice()); }
    close() { this.connected = false; }
    setSubscribers(count) {
      this.peerCount = count;
      this.canTransmit = count > 0;
      const event = new Event("subscriberchange");
      Object.defineProperty(event, "detail", { value: { count } });
      this.dispatchEvent(event);
    }
  }

  const noiseSecretKey = x25519.utils.randomSecretKey();
  const signingSecretKey = ed25519.utils.randomSecretKey();
  const noisePublicKey = x25519.getPublicKey(noiseSecretKey);
  const peerID = peerIDFromNoisePublicKey(noisePublicKey);
  const link = new FakePeripheralLink();
  const statuses = [];
  const adapter = new WebBluetoothMeshAdapter({
    identity: {
      noiseSecretKey,
      noisePublicKey,
      signingSecretKey,
      signingPublicKey: ed25519.getPublicKey(signingSecretKey),
      peerID,
      peerIDHex: bytesToHex(peerID)
    },
    nickname: "desktop",
    connector: { connect: async () => link },
    onStatus: (status) => statuses.push(status)
  });

  await adapter.connect({ network: "mainnet" });
  assert.equal(link.writes.length, 0);
  assert.equal(adapter.canTransmit, false);
  await assert.rejects(
    adapter.sendPublicMessage("sans téléphone"),
    /Aucun appareil BitChat/
  );

  link.setSubscribers(1);
  await waitForCondition(
    () => adapter.canTransmit && link.writes.some(
      (frame) => decodeBitChatPacket(frame)?.type === BitChatMessageType.announce
    ),
    "the first GATT subscriber"
  );
  assert.equal(adapter.canTransmit, true);
  assert.ok(link.writes.some((frame) => decodeBitChatPacket(frame)?.type === BitChatMessageType.announce));
  await adapter.sendPublicMessage("avec téléphone");
  assert.ok(link.writes.some((frame) => decodeBitChatPacket(frame)?.type === BitChatMessageType.message));
  assert.equal(statuses.at(-1).peerCount, 1);
  assert.equal(statuses.at(-1).canTransmit, true);
  adapter.disconnect();
});

test("compressed native frames retain their exact signed wire payload", () => {
  const signingSecretKey = ed25519.utils.randomSecretKey();
  const plaintext = utf8ToBytes("compressible ".repeat(80));
  const wirePayload = concatBytes(writeUint16BE(plaintext.length), zlibSync(plaintext));
  const packet = signBitChatPacket({
    version: 1,
    type: BitChatMessageType.message,
    ttl: 7,
    timestamp: Date.now(),
    senderID: randomBytes(8),
    recipientID: null,
    payload: plaintext,
    wirePayload,
    isCompressed: true,
    signature: null
  }, signingSecretKey);
  const decoded = decodeBitChatPacket(encodeBitChatPacket(packet));
  assert.equal(bytesToUtf8(decoded.payload), bytesToUtf8(plaintext));
  assert.equal(verifyBitChatPacket(decoded, ed25519.getPublicKey(signingSecretKey)), true);
});

test("private message TLV and relay URL validation stay bounded", () => {
  const encoded = encodePrivateMessagePayload("message-id", "secret");
  assert.deepEqual(decodePrivateMessagePayload(encoded), {
    id: "message-id",
    content: "secret"
  });
  assert.equal(isNostrRelayURL("wss://relay.damus.io"), true);
  assert.equal(isNostrRelayURL("ws://insecure.example"), false);
  assert.equal(isNostrRelayURL("https://not-a-websocket.example"), false);
});

test("file transfer TLV matches the native v2 Android and Apple layout", () => {
  const file = {
    fileName: "a.jpg",
    mimeType: "image/jpeg",
    content: Uint8Array.of(0xde, 0xad, 0xbe, 0xef)
  };
  const encoded = encodeFileTransferPayload(file);
  assert.equal(
    bytesToHex(encoded),
    "010005612e6a70670200040000000403000a696d6167652f6a7065670400000004deadbeef"
  );
  assert.deepEqual(decodeFileTransferPayload(encoded), {
    ...file,
    fileSize: 4
  });
  assert.equal(decodeFileTransferPayload(encoded.slice(0, -1)), null);
});

test("delivery and read receipts share the native Noise payload contract", () => {
  for (const type of ["delivered", "readReceipt"]) {
    const encoded = encodeMessageReceiptPayload(type, "message-id");
    assert.deepEqual(decodeNoisePayload(encoded), {
      type,
      messageID: "message-id"
    });
  }
  assert.throws(() => encodeMessageReceiptPayload("unknown", "message-id"));
  assert.equal(decodeNoisePayload(Uint8Array.of(0x02)), null);
});

test("BitChat Nostr envelope decrypts the frozen iOS and Android fixtures", async () => {
  const legacyEvent = JSON.parse(await readFile(
    new URL("LegacyPrivateEnvelope733098bb.json", nostrFixturesURL),
    "utf8"
  ));
  const legacyKey = JSON.parse(await readFile(
    new URL("LegacyPrivateEnvelope733098bbRecipientKey.json", nostrFixturesURL),
    "utf8"
  ));
  const legacy = openBitChatPrivateEnvelope({
    giftWrap: legacyEvent,
    recipientSecretKey: hexToBytes(legacyKey.recipient_private_key)
  });
  assert.equal(legacy.content, "legacy fixture from 733098bb");
  assert.equal(
    legacy.senderPublicKey,
    "2e3d79df7047204f02b726c574e256f8de1dd80510f7dcb8b0d12df13acb87e6"
  );

  const androidEvent = JSON.parse(await readFile(
    new URL("AndroidLegacyPrivateEnvelopeB7f0b33d.json", nostrFixturesURL),
    "utf8"
  ));
  const androidMetadata = JSON.parse(await readFile(
    new URL("AndroidLegacyPrivateEnvelopeB7f0b33dMetadata.json", nostrFixturesURL),
    "utf8"
  ));
  const android = openBitChatPrivateEnvelope({
    giftWrap: androidEvent,
    recipientSecretKey: hexToBytes(androidMetadata.recipient_private_key)
  });
  assert.equal(android.content, "legacy fixture from Android b7f0b33d");
  assert.equal(android.senderPublicKey, androidMetadata.sender_public_key);
});

test("BitChat Nostr private messages round-trip with the native embedded packet", () => {
  const senderSecretKey = randomBytes(32);
  const recipientSecretKey = randomBytes(32);
  const senderPeerID = randomBytes(8);
  const messageID = crypto.randomUUID();
  const embedded = encodeBitChatNostrPrivateMessage({
    content: "message privé",
    messageID,
    senderPeerID,
    timestamp: 1_700_000_000_000
  });
  const giftWrap = createBitChatPrivateEnvelope({
    content: embedded,
    recipientPublicKey: getPublicKey(recipientSecretKey),
    senderSecretKey,
    now: 1_700_000_000_000
  });
  const opened = openBitChatPrivateEnvelope({ giftWrap, recipientSecretKey });
  const decoded = decodeBitChatNostrPrivateMessage(opened.content);
  assert.deepEqual(decoded, {
    id: messageID,
    content: "message privé",
    senderPeerID: bytesToHex(senderPeerID),
    timestamp: 1_700_000_000_000
  });

  const tampered = {
    ...JSON.parse(JSON.stringify(giftWrap)),
    sig: `${giftWrap.sig[0] === "0" ? "1" : "0"}${giftWrap.sig.slice(1)}`
  };
  assert.throws(
    () => openBitChatPrivateEnvelope({ giftWrap: tampered, recipientSecretKey }),
    /invalide|déchiffrer/
  );
});

test("BitChat Nostr receipts reuse the embedded native packet", () => {
  const senderPeerID = randomBytes(8);
  for (const type of ["delivered", "readReceipt"]) {
    const embedded = encodeBitChatNostrMessageReceipt({
      type,
      messageID: "receipt-message-id",
      senderPeerID,
      timestamp: 1_700_000_000_100
    });
    assert.deepEqual(decodeBitChatNostrPayload(embedded), {
      type,
      messageID: "receipt-message-id",
      senderPeerID: bytesToHex(senderPeerID),
      timestamp: 1_700_000_000_100
    });
  }
});
