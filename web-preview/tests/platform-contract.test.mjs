import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BitChatBLE,
  BitChatMessageType,
  BitChatNetwork,
  BitChatNoisePayloadType
} from "../src/features/native-connectivity/bit-chat-codec.js";
import { NoiseProtocolName } from "../src/features/native-connectivity/noise-xx.js";
import { BitChatNostrContract } from "../src/features/native-connectivity/bit-chat-nostr-envelope.js";

const contractURL = new URL("../../protocol-conformance/bitchat-wire-v1.json", import.meta.url);
const contract = JSON.parse(await readFile(contractURL, "utf8"));
const androidConfigurationURL = new URL("../../apps/android/upstream.json", import.meta.url);
const androidConfiguration = JSON.parse(await readFile(androidConfigurationURL, "utf8"));
const androidCheckoutURL = new URL(`../../${androidConfiguration.checkoutDirectory}/`, import.meta.url);
const appleMessageTypesURL = new URL(
  "../../localPackages/BitFoundation/Sources/BitFoundation/MessageType.swift",
  import.meta.url
);
const appleNoiseTypesURL = new URL("../../bitchat/Protocols/BitchatProtocol.swift", import.meta.url);
const androidMessageTypesURL = new URL(
  "app/src/main/java/com/bitchat/android/protocol/BinaryProtocol.kt",
  androidCheckoutURL
);
const androidNoiseTypesURL = new URL(
  "app/src/main/java/com/bitchat/android/model/NoiseEncrypted.kt",
  androidCheckoutURL
);

function swiftCases(source) {
  return Object.fromEntries([...source.matchAll(/case\s+(\w+)\s*=\s*0x([0-9a-f]+)/gi)]
    .map((match) => [match[1], Number.parseInt(match[2], 16)]));
}

function kotlinCases(source) {
  return Object.fromEntries([...source.matchAll(/^\s*([A-Z][A-Z_]*)\(0x([0-9a-f]+)u\)/gmi)]
    .map((match) => [match[1], Number.parseInt(match[2], 16)]));
}

test("the portable runtime follows the shared BitChat wire contract", () => {
  assert.deepEqual(contract.packetVersions, [1, 2]);
  assert.equal(BitChatNetwork.mainnet.serviceUUID, contract.bluetooth.mainnetServiceUuid);
  assert.equal(BitChatNetwork.testnet.serviceUUID, contract.bluetooth.testnetServiceUuid);
  assert.equal(BitChatBLE.characteristicUUID, contract.bluetooth.characteristicUuid);
  assert.equal(BitChatBLE.defaultTTL, contract.bluetooth.defaultTtl);
  assert.equal(BitChatBLE.fragmentChunkBytes, contract.bluetooth.fragmentChunkBytes);
  assert.deepEqual(BitChatMessageType, contract.messageTypes);
  assert.equal(NoiseProtocolName, contract.noise.protocolName);
  assert.deepEqual(BitChatNoisePayloadType, contract.noise.payloadTypes);
});

test("the shared Nostr contract documents the interoperable event envelope", () => {
  assert.deepEqual(BitChatNostrContract, contract.nostr);
});

test("the shared contract stays aligned with the untouched Apple protocol source", async () => {
  const appleMessages = swiftCases(await readFile(appleMessageTypesURL, "utf8"));
  const appleNoise = swiftCases(await readFile(appleNoiseTypesURL, "utf8"));
  assert.deepEqual(appleMessages, contract.messageTypes);
  for (const [name, value] of Object.entries(contract.noise.payloadTypes)) {
    assert.equal(appleNoise[name], value, `Apple Noise type ${name}`);
  }
});

test("the shared contract preserves the official Android wire subset", async () => {
  const androidMessages = kotlinCases(await readFile(androidMessageTypesURL, "utf8"));
  const androidNoise = kotlinCases(await readFile(androidNoiseTypesURL, "utf8"));
  const messageMapping = {
    ANNOUNCE: "announce",
    MESSAGE: "message",
    LEAVE: "leave",
    NOISE_HANDSHAKE: "noiseHandshake",
    NOISE_ENCRYPTED: "noiseEncrypted",
    FRAGMENT: "fragment",
    REQUEST_SYNC: "requestSync",
    FILE_TRANSFER: "fileTransfer",
    VOICE_FRAME: "voiceFrame"
  };
  const noiseMapping = {
    PRIVATE_MESSAGE: "privateMessage",
    READ_RECEIPT: "readReceipt",
    DELIVERED: "delivered",
    VOICE_FRAME: "voiceFrame",
    VERIFY_CHALLENGE: "verifyChallenge",
    VERIFY_RESPONSE: "verifyResponse",
    FILE_TRANSFER: "privateFile",
    PEER_STATE: "authenticatedPeerState"
  };
  for (const [androidName, contractName] of Object.entries(messageMapping)) {
    assert.equal(androidMessages[androidName], contract.messageTypes[contractName], androidName);
  }
  for (const [androidName, contractName] of Object.entries(noiseMapping)) {
    assert.equal(androidNoise[androidName], contract.noise.payloadTypes[contractName], androidName);
  }
  assert.equal(contract.noise.decodeAliases.privateFile.includes(0x09), true);
});
