import { CoreLimits } from "./config.js";

function djb2UTF8(value) {
  let hash = 5_381n;
  for (const byte of new TextEncoder().encode(value)) {
    hash = ((hash << 5n) + hash + BigInt(byte)) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export const ContentNormalizer = Object.freeze({
  normalizedKey(content, prefixLength = CoreLimits.contentKeyPrefixCharacters) {
    const simplified = String(content)
      .toLowerCase()
      .replace(/https?:\/\/[^\s?#]+(?:[?#][^\s]*)?/gi, (url) => url.split(/[?#]/u, 1)[0])
      .trim()
      .replace(/\s+/gu, " ");
    const prefix = Array.from(simplified).slice(0, prefixLength).join("");
    return `h:${djb2UTF8(prefix)}`;
  }
});

export class MessageDeduplicator {
  #entries = new Map();

  constructor({
    maximumAgeMilliseconds = CoreLimits.messageDedupMaxAgeMilliseconds,
    maximumCount = CoreLimits.messageDedupMaxCount
  } = {}) {
    this.maximumAgeMilliseconds = maximumAgeMilliseconds;
    this.maximumCount = maximumCount;
  }

  isDuplicate(identifier, now = Date.now()) {
    this.cleanup(now);
    const key = String(identifier);
    if (this.#entries.has(key)) return true;
    this.#entries.set(key, now);
    this.#trim();
    return false;
  }

  contains(identifier) {
    return this.#entries.has(String(identifier));
  }

  reset() {
    this.#entries.clear();
  }

  cleanup(now = Date.now()) {
    const cutoff = now - this.maximumAgeMilliseconds;
    for (const [identifier, timestamp] of this.#entries) {
      if (timestamp >= cutoff) break;
      this.#entries.delete(identifier);
    }
  }

  #trim() {
    if (this.#entries.size <= this.maximumCount) return;
    const targetCount = Math.floor(this.maximumCount * 0.75);
    const removeCount = this.#entries.size - targetCount;
    for (const identifier of [...this.#entries.keys()].slice(0, removeCount)) {
      this.#entries.delete(identifier);
    }
  }
}

class TokenBucket {
  constructor(capacity, refillPerSecond, now) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerSecond = refillPerSecond;
    this.lastRefill = now;
  }

  allow(now, cost = 1) {
    const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1_000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
      this.lastRefill = now;
    }
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export class MessageRateLimiter {
  #senderBuckets = new Map();
  #contentBuckets = new Map();

  constructor({
    senderCapacity = CoreLimits.senderBucketCapacity,
    senderRefillPerSecond = CoreLimits.senderBucketRefillPerSecond,
    contentCapacity = CoreLimits.contentBucketCapacity,
    contentRefillPerSecond = CoreLimits.contentBucketRefillPerSecond,
    maximumSenderBuckets = CoreLimits.rateBucketMaxEntries,
    maximumContentBuckets = CoreLimits.rateBucketMaxEntries,
    bucketIdleMilliseconds = CoreLimits.rateBucketIdleMilliseconds
  } = {}) {
    this.senderCapacity = senderCapacity;
    this.senderRefillPerSecond = senderRefillPerSecond;
    this.contentCapacity = contentCapacity;
    this.contentRefillPerSecond = contentRefillPerSecond;
    this.maximumSenderBuckets = Math.max(1, maximumSenderBuckets);
    this.maximumContentBuckets = Math.max(1, maximumContentBuckets);
    this.bucketIdleMilliseconds = bucketIdleMilliseconds;
  }

  allow({ senderKey, contentKey, now = Date.now() }) {
    const senderBucket = this.#bucket(
      this.#senderBuckets,
      String(senderKey),
      this.senderCapacity,
      this.senderRefillPerSecond,
      this.maximumSenderBuckets,
      now
    );
    if (!senderBucket.allow(now)) return false;

    const contentBucket = this.#bucket(
      this.#contentBuckets,
      String(contentKey),
      this.contentCapacity,
      this.contentRefillPerSecond,
      this.maximumContentBuckets,
      now
    );
    return contentBucket.allow(now);
  }

  reset() {
    this.#senderBuckets.clear();
    this.#contentBuckets.clear();
  }

  get bucketCounts() {
    return {
      sender: this.#senderBuckets.size,
      content: this.#contentBuckets.size
    };
  }

  #bucket(buckets, key, capacity, refillPerSecond, maximumBuckets, now) {
    const existing = buckets.get(key);
    if (existing) return existing;

    if (buckets.size >= maximumBuckets) {
      for (const [bucketKey, bucket] of buckets) {
        if (now - bucket.lastRefill >= this.bucketIdleMilliseconds) buckets.delete(bucketKey);
      }
    }
    if (buckets.size >= maximumBuckets) {
      const oldestKey = [...buckets].sort((left, right) => left[1].lastRefill - right[1].lastRefill)[0]?.[0];
      if (oldestKey) buckets.delete(oldestKey);
    }

    const bucket = new TokenBucket(capacity, refillPerSecond, now);
    buckets.set(key, bucket);
    return bucket;
  }
}
