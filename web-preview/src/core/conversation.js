import { WebFeatureLimits } from "./config.js";

const clientIDPattern = /^[a-zA-Z0-9._-]{8,80}$/;
const directConversationPattern = /^dm:([a-zA-Z0-9._-]{8,80}):([a-zA-Z0-9._-]{8,80})$/;

export const PublicConversation = Object.freeze({
  mesh: "mesh",
  geohash: "geo"
});

export function normalizeClientID(value) {
  const clientID = String(value ?? "").trim().slice(0, WebFeatureLimits.clientIDCharacters);
  return clientIDPattern.test(clientID) ? clientID : null;
}

export function createPrivateConversationID(firstClientID, secondClientID) {
  const first = normalizeClientID(firstClientID);
  const second = normalizeClientID(secondClientID);
  if (!first || !second || first === second) return null;
  return `dm:${[first, second].sort().join(":")}`;
}

export function normalizeConversationID(value) {
  const conversationID = String(value ?? "").trim().slice(0, WebFeatureLimits.conversationIDCharacters);
  if (conversationID === PublicConversation.mesh || conversationID === PublicConversation.geohash) {
    return conversationID;
  }

  const match = directConversationPattern.exec(conversationID);
  if (!match) return null;
  return createPrivateConversationID(match[1], match[2]) === conversationID ? conversationID : null;
}

export function participantIDsForConversation(conversationID) {
  const match = directConversationPattern.exec(normalizeConversationID(conversationID) ?? "");
  return match ? [match[1], match[2]] : [];
}

export function isPrivateConversation(conversationID) {
  return participantIDsForConversation(conversationID).length === 2;
}
