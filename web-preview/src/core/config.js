/**
 * Portable BitChat domain limits.
 *
 * Native sources of truth:
 * - bitchat/Utils/InputValidator.swift
 * - bitchat/Protocols/Packets.swift (PrivateMessagePacket)
 * - bitchat/Services/TransportConfig.swift
 *
 * These values are covered by parity tests in web-preview/tests/core.test.mjs.
 * Server and browser code import this module instead of repeating literals.
 */
export const CoreLimits = Object.freeze({
  nicknameCharacters: 50,
  publicMessageUTF8Bytes: 16_000,
  privateMessageUTF8Bytes: 255,
  groupMessageUTF8Bytes: 60_000,
  timestampSkewMilliseconds: 5 * 60 * 1_000,
  contentKeyPrefixCharacters: 256,
  messageDedupMaxAgeMilliseconds: 5 * 60 * 1_000,
  messageDedupMaxCount: 1_000,
  contentCacheCapacity: 2_000,
  senderBucketCapacity: 5,
  senderBucketRefillPerSecond: 1,
  contentBucketCapacity: 3,
  contentBucketRefillPerSecond: 0.5,
  rateBucketMaxEntries: 2_000,
  rateBucketIdleMilliseconds: 10 * 60 * 1_000
});

/**
 * Limits that belong only to the Web feature and its local HTTP adapter.
 * They are deliberately kept out of the portable BitChat contract.
 */
export const WebFeatureLimits = Object.freeze({
  clientIDCharacters: 80,
  conversationIDCharacters: 190,
  requestBytes: 2_500_000,
  persistedMessages: 600,
  imageDataURLCharacters: 2_200_000,
  imageFileBytes: 1_500_000,
  quoteCharacters: 240
});
