import test from "node:test";
import assert from "node:assert/strict";
import {
  ContentNormalizer,
  CoreLimits,
  DeliveryStatusKind,
  InputValidator,
  MessageDeduplicator,
  MessageRateLimiter,
  createBitchatMessage,
  createPrivateConversationID,
  extractMentions,
  isPrivateConversation,
  normalizeConversationID,
  participantIDsForConversation,
  withDeliveryStatus
} from "../src/core/index.js";

test("InputValidator matches native nickname rules", () => {
  assert.equal(InputValidator.validateNickname("  Alice 🚀  "), "Alice 🚀");
  assert.equal(InputValidator.validateNickname("a".repeat(CoreLimits.nicknameCharacters)), "a".repeat(50));
  assert.equal(InputValidator.validateNickname("a".repeat(CoreLimits.nicknameCharacters + 1)), null);
  assert.equal(InputValidator.validateNickname("Alice\u0000"), null);
  assert.equal(InputValidator.validateNickname("   "), null);
});

test("message limits are measured in UTF-8 bytes", () => {
  assert.equal(InputValidator.validatePrivateMessage("a".repeat(255)), "a".repeat(255));
  assert.equal(InputValidator.validatePrivateMessage("a".repeat(256)), null);
  assert.equal(InputValidator.validatePrivateMessage("🚀".repeat(63)), "🚀".repeat(63));
  assert.equal(InputValidator.validatePrivateMessage("🚀".repeat(64)), null);
  assert.equal(InputValidator.validatePublicMessage("a".repeat(16_000)), "a".repeat(16_000));
  assert.equal(InputValidator.validatePublicMessage("a".repeat(16_001)), null);
});

test("timestamp validation uses the native five-minute replay window", () => {
  const now = Date.now();
  assert.equal(InputValidator.validateTimestamp(now, now), true);
  assert.equal(InputValidator.validateTimestamp(now - 299_000, now), true);
  assert.equal(InputValidator.validateTimestamp(now - 301_000, now), false);
  assert.equal(InputValidator.validateTimestamp(now + 301_000, now), false);
});

test("private conversation identifiers are canonical and deterministic", () => {
  const alpha = "peer-alpha-0001";
  const beta = "peer-beta-00002";
  const identifier = createPrivateConversationID(beta, alpha);
  assert.equal(identifier, `dm:${alpha}:${beta}`);
  assert.equal(normalizeConversationID(identifier), identifier);
  assert.deepEqual(participantIDsForConversation(identifier), [alpha, beta]);
  assert.equal(isPrivateConversation(identifier), true);
  assert.equal(createPrivateConversationID(alpha, alpha), null);
});

test("BitchatMessage model keeps native fields and mention semantics", () => {
  const timestamp = Date.now();
  const publicMessage = createBitchatMessage({
    id: "message-public-001",
    sender: "Alice",
    content: "hello @Bob and @Bob",
    timestamp
  });

  assert.equal(publicMessage.sender, "Alice");
  assert.equal(publicMessage.content, "hello @Bob and @Bob");
  assert.deepEqual(publicMessage.mentions, ["Bob"]);
  assert.equal(publicMessage.isPrivate, false);
  assert.equal(publicMessage.deliveryStatus, null);

  const privateMessage = createBitchatMessage({
    id: "message-private-01",
    sender: "Alice",
    content: "secret",
    timestamp,
    isPrivate: true,
    recipientNickname: "Bob",
    senderPeerID: "peer-alpha-0001"
  });
  assert.equal(privateMessage.deliveryStatus.kind, DeliveryStatusKind.sending);
  assert.equal(
    withDeliveryStatus(privateMessage, DeliveryStatusKind.sent).deliveryStatus.kind,
    DeliveryStatusKind.sent
  );
  assert.deepEqual(extractMentions("hi @A @B-C"), ["A", "B-C"]);
});

test("content normalization follows native case, whitespace and URL rules", () => {
  const base = ContentNormalizer.normalizedKey("Check https://example.com/page");
  assert.equal(base, ContentNormalizer.normalizedKey("  CHECK   https://example.com/page?query=1  "));
  assert.equal(base, ContentNormalizer.normalizedKey("check https://example.com/page#anchor"));
  assert.match(base, /^h:[0-9a-f]{16}$/);
  assert.notEqual(
    ContentNormalizer.normalizedKey("http://example.com/page"),
    ContentNormalizer.normalizedKey("https://example.com/page")
  );
});

test("deduplicator expires and bounds identifiers", () => {
  const deduplicator = new MessageDeduplicator({
    maximumAgeMilliseconds: 100,
    maximumCount: 4
  });
  assert.equal(deduplicator.isDuplicate("a", 1_000), false);
  assert.equal(deduplicator.isDuplicate("a", 1_001), true);
  assert.equal(deduplicator.isDuplicate("a", 1_101), false);

  for (const identifier of ["b", "c", "d", "e"]) {
    deduplicator.isDuplicate(identifier, 1_102);
  }
  assert.equal(deduplicator.contains("a"), false);
  assert.equal(deduplicator.contains("e"), true);
});

test("rate limiter applies independent sender and content buckets", () => {
  const limiter = new MessageRateLimiter({
    senderCapacity: 2,
    senderRefillPerSecond: 0,
    contentCapacity: 1,
    contentRefillPerSecond: 0,
    maximumSenderBuckets: 10,
    maximumContentBuckets: 10
  });
  const now = 1_000;

  assert.equal(limiter.allow({ senderKey: "a", contentKey: "one", now }), true);
  assert.equal(limiter.allow({ senderKey: "a", contentKey: "two", now }), true);
  assert.equal(limiter.allow({ senderKey: "a", contentKey: "three", now }), false);
  assert.equal(limiter.allow({ senderKey: "b", contentKey: "one", now }), false);
  assert.deepEqual(limiter.bucketCounts, { sender: 2, content: 2 });
});
