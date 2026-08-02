import {
  BitChatBLE,
  BitChatMessageType,
  verifyBitChatPacket
} from "./bit-chat-codec.js";
import { readUint16BE } from "../../core/bytes.js";
import { BitChatWireContract } from "./wire-contract.js";

const maximumOpaqueBytes = BitChatWireContract.fileTransfer.maximumPayloadBytes + 132 * 1024;

function hasValidOuterSignature(packet, peer) {
  return Boolean(peer && verifyBitChatPacket(packet, peer.signingPublicKey));
}

export function acceptsFragmentForRelay(packet, peer = null) {
  if (!peer
    || packet?.type !== BitChatMessageType.fragment
    || packet.payload.length < 13
    || packet.payload.length > BitChatBLE.fragmentChunkBytes + 13) {
    return false;
  }
  const index = readUint16BE(packet.payload, 8);
  const total = readUint16BE(packet.payload, 10);
  const originalType = packet.payload[12];
  const maximumFragments = Math.ceil(maximumOpaqueBytes / BitChatBLE.fragmentChunkBytes) + 1;
  return total > 0
    && total <= maximumFragments
    && index < total
    && Object.values(BitChatMessageType).includes(originalType)
    && originalType !== BitChatMessageType.fragment
    && originalType !== BitChatMessageType.requestSync;
}

/**
 * Validates packet families that the Desktop node relays without interpreting.
 * Domain handlers remain responsible for packets the Web feature consumes.
 */
export function acceptsOpaquePacketForRelay(packet, peer = null) {
  if (!packet?.payload || packet.payload.length > maximumOpaqueBytes) return false;
  switch (packet.type) {
    case BitChatMessageType.courierEnvelope:
      return Boolean(packet.recipientID) && hasValidOuterSignature(packet, peer);
    case BitChatMessageType.requestSync:
      return false;
    case BitChatMessageType.fileTransfer:
    case BitChatMessageType.boardPost:
    case BitChatMessageType.prekeyBundle:
      return hasValidOuterSignature(packet, peer);
    case BitChatMessageType.groupMessage:
      return !packet.recipientID && packet.payload.length > 0;
    case BitChatMessageType.ping:
    case BitChatMessageType.pong:
      return Boolean(packet.recipientID)
        && packet.payload.length >= 9
        && packet.payload.length <= 64;
    case BitChatMessageType.nostrCarrier:
      return packet.payload.length > 0
        && (packet.recipientID ? hasValidOuterSignature(packet, peer) : true);
    case BitChatMessageType.voiceFrame:
      return !packet.recipientID
        && packet.payload.length >= 11
        && packet.payload.length <= 64 * 1024
        && hasValidOuterSignature(packet, peer);
    default:
      return false;
  }
}
