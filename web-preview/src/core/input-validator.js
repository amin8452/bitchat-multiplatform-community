import { CoreLimits } from "./config.js";

const utf8Encoder = new TextEncoder();
const controlCharacterPattern = /[\u0000-\u001F\u007F-\u009F]/u;
const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function graphemeCount(value) {
  if (!graphemeSegmenter) return Array.from(value).length;
  return [...graphemeSegmenter.segment(value)].length;
}

function trimmedOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Browser-safe port of InputValidator.swift.
 *
 * It is pure domain logic: no DOM, storage, HTTP or logging dependency.
 */
export const InputValidator = Object.freeze({
  validateUserString(value, maximumCharacters) {
    const trimmed = trimmedOrNull(value);
    if (!trimmed || graphemeCount(trimmed) > maximumCharacters) return null;
    return controlCharacterPattern.test(trimmed) ? null : trimmed;
  },

  validateNickname(value) {
    return this.validateUserString(value, CoreLimits.nicknameCharacters);
  },

  validateMessage(value, maximumUTF8Bytes) {
    const trimmed = trimmedOrNull(value);
    if (!trimmed) return null;
    return utf8Encoder.encode(trimmed).byteLength <= maximumUTF8Bytes ? trimmed : null;
  },

  validatePublicMessage(value) {
    return this.validateMessage(value, CoreLimits.publicMessageUTF8Bytes);
  },

  validatePrivateMessage(value) {
    return this.validateMessage(value, CoreLimits.privateMessageUTF8Bytes);
  },

  validateGroupMessage(value) {
    return this.validateMessage(value, CoreLimits.groupMessageUTF8Bytes);
  },

  validateTimestamp(timestamp, now = Date.now()) {
    const value = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
    return Number.isFinite(value)
      && value >= now - CoreLimits.timestampSkewMilliseconds
      && value <= now + CoreLimits.timestampSkewMilliseconds;
  },

  utf8ByteLength(value) {
    return utf8Encoder.encode(String(value)).byteLength;
  }
});
