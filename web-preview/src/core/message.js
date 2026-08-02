import { InputValidator } from "./input-validator.js";

export const DeliveryStatusKind = Object.freeze({
  sending: "sending",
  sent: "sent",
  carried: "carried",
  delivered: "delivered",
  read: "read",
  failed: "failed",
  partiallyDelivered: "partiallyDelivered"
});

const mentionPattern = /(?:^|\s)@([\p{L}\p{N}_.-]{1,50})/gu;

export function extractMentions(content) {
  return [...String(content).matchAll(mentionPattern)]
    .map((match) => match[1])
    .filter((nickname, index, values) => values.indexOf(nickname) === index);
}

/**
 * Creates the portable subset of BitFoundation.BitchatMessage.
 *
 * Transport-specific metadata stays in an envelope owned by an adapter.
 */
export function createBitchatMessage({
  id = crypto.randomUUID(),
  sender,
  content,
  timestamp = Date.now(),
  isRelay = false,
  originalSender = null,
  isPrivate = false,
  recipientNickname = null,
  senderPeerID = null,
  mentions,
  deliveryStatus,
  isBridged = false,
  acceptHistoricalTimestamp = false
}) {
  const validatedSender = InputValidator.validateNickname(sender);
  const validatedContent = isPrivate
    ? InputValidator.validatePrivateMessage(content)
    : InputValidator.validatePublicMessage(content);

  const numericTimestamp = Number(timestamp);
  const validTimestamp = acceptHistoricalTimestamp
    ? Number.isFinite(numericTimestamp) && numericTimestamp >= 0
    : InputValidator.validateTimestamp(numericTimestamp);
  if (!validatedSender || !validatedContent || !validTimestamp) {
    return null;
  }

  return Object.freeze({
    id: String(id),
    sender: validatedSender,
    content: validatedContent,
    timestamp: numericTimestamp,
    isRelay: Boolean(isRelay),
    originalSender: originalSender ? String(originalSender) : null,
    isPrivate: Boolean(isPrivate),
    recipientNickname: recipientNickname ? String(recipientNickname) : null,
    senderPeerID: senderPeerID ? String(senderPeerID) : null,
    mentions: mentions ?? extractMentions(validatedContent),
    deliveryStatus: deliveryStatus ?? (isPrivate ? { kind: DeliveryStatusKind.sending } : null),
    isBridged: Boolean(isBridged)
  });
}

export function withDeliveryStatus(message, kind, details = {}) {
  if (!Object.values(DeliveryStatusKind).includes(kind)) return message;
  return Object.freeze({
    ...message,
    deliveryStatus: { kind, ...details }
  });
}

/**
 * Converts records produced by the first Web preview into the current
 * BitchatMessage-shaped record without losing the user's local history.
 */
export function migrateLegacyMessage(record) {
  if (!record || typeof record !== "object") return null;
  if (record.sender && record.content && record.timestamp) return record;

  const {
    author,
    text,
    createdAt,
    ...currentFields
  } = record;

  return {
    ...currentFields,
    sender: author ?? "anonymous",
    content: text ?? (record.type === "voice" ? `[voice:${record.duration ?? "0:00"}]` : record.type === "image" ? "[image]" : ""),
    timestamp: Number(createdAt ?? Date.now()),
    isRelay: false,
    originalSender: null,
    isPrivate: String(record.conversationId ?? "").startsWith("dm:"),
    recipientNickname: null,
    senderPeerID: record.authorId ?? null,
    mentions: extractMentions(record.text ?? ""),
    deliveryStatus: record.deliveryStatus ?? { kind: DeliveryStatusKind.sent },
    isBridged: false
  };
}
