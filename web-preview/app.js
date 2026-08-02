import {
  CoreLimits,
  DeliveryStatusKind,
  InputValidator,
  WebFeatureLimits,
  createBitchatMessage,
  createPrivateConversationID,
  isPrivateConversation,
  participantIDsForConversation,
  withDeliveryStatus
} from "./src/core/index.js";
import { RealtimeChatClient } from "./src/adapters/realtime-chat-client.js";
import { BrowserQRCodeReader } from "@zxing/browser";
import QRCode from "qrcode";
import { loadMeshIdentity } from "./src/features/native-connectivity/browser-mesh-identity.js";
import {
  buildVerificationQR,
  parseAndVerifyVerificationQR
} from "./src/features/native-connectivity/identity-verification.js";
import { NostrGeohashAdapter } from "./src/features/native-connectivity/nostr-geohash-adapter.js";
import { WebBluetoothMeshAdapter } from "./src/features/native-connectivity/web-bluetooth-mesh-adapter.js";
import { BitChatFileTransferLimits } from "./src/features/native-connectivity/bit-chat-codec.js";
import { optimizeImageForTransfer } from "./src/features/media/image-transfer-optimizer.js";
import { VoiceNoteRecorder } from "./src/features/media/voice-note-recorder.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const elements = {
  appShell: $("#appShell"),
  mobileBackdrop: $("#mobileBackdrop"),
  menuButton: $("#menuButton"),
  peopleButton: $("#peopleButton"),
  verificationButton: $("#verificationButton"),
  closeDetailsButton: $("#closeDetailsButton"),
  peopleList: $("#peopleList"),
  peopleCount: $("#peopleCount"),
  conversationNav: $("#conversationNav"),
  conversationSearch: $("#conversationSearch"),
  headerSymbol: $("#headerSymbol"),
  headerTitle: $("#headerTitle"),
  headerSubtitle: $("#headerSubtitle"),
  channelPickerButton: $("#channelPickerButton"),
  messageStage: $("#messageStage"),
  messageList: $("#messageList"),
  jumpButton: $("#jumpButton"),
  composerForm: $("#composerForm"),
  messageInput: $("#messageInput"),
  sendButton: $("#sendButton"),
  attachButton: $("#attachButton"),
  fileInput: $("#fileInput"),
  emojiButton: $("#emojiButton"),
  emojiPopover: $("#emojiPopover"),
  composerHint: $("#composerHint"),
  replyPreview: $("#replyPreview"),
  replyAuthor: $("#replyAuthor"),
  replyText: $("#replyText"),
  cancelReplyButton: $("#cancelReplyButton"),
  recordingPreview: $("#recordingPreview"),
  recordingTime: $("#recordingTime"),
  noticesButton: $("#noticesButton"),
  settingsButton: $("#settingsButton"),
  profileButton: $("#profileButton"),
  infoButton: $("#infoButton"),
  modeButton: $("#modeButton"),
  profileNickname: $("#profileNickname"),
  profileInitials: $("#profileInitials"),
  modalLayer: $("#modalLayer"),
  modalEyebrow: $("#modalEyebrow"),
  modalTitle: $("#modalTitle"),
  modalContent: $("#modalContent"),
  toast: $("#toast"),
  toastText: $("#toastText"),
  liveRegion: $("#liveRegion"),
  connectionChip: $("#connectionChip"),
  connectionLabel: $("#connectionLabel"),
  meshStatusTitle: $("#meshStatusTitle"),
  meshStatusDetail: $("#meshStatusDetail"),
  meshStatusPill: $("#meshStatusPill"),
  rangeSummaryTitle: $("#rangeSummaryTitle"),
  rangeSummaryDetail: $("#rangeSummaryDetail")
};

const avatarClasses = [
  "avatar-teal",
  "avatar-purple",
  "avatar-amber",
  "avatar-blue",
  "avatar-green",
  "avatar-rose"
];

const authorColors = ["#53d6c7", "#b490ff", "#f0a153", "#75a3ff", "#55d291", "#e985a8"];
const testNames = ["Amina", "Léo", "Nora", "Sam", "Inès", "Mika", "Kai", "Tomi"];

const channelMetadata = {
  mesh: {
    title: "#mesh",
    icon: "radio",
    placeholder: "Message dans #mesh",
    system: "Canal local dynamique · les fenêtres ouvertes reçoivent les messages en temps réel"
  },
  geo: {
    title: "#u33dc",
    icon: "hash",
    placeholder: "Message public dans #u33dc",
    system: "Canal geohash public · le relais Nostr reste optionnel et désactivé par défaut"
  }
};

const urlParameters = new URLSearchParams(window.location.search);
const participantParameter = urlParameters.get("participant");
const instanceParameter = urlParameters.get("instance");
const forceNewIdentity = Boolean(participantParameter || instanceParameter);
const isDesktopNativeRadio = Boolean(globalThis.bitchatDesktopRadio);
const verifiedFingerprintsStorageKey = "bitchat-verified-fingerprints-v1";

function loadVerifiedFingerprints() {
  try {
    const stored = JSON.parse(localStorage.getItem(verifiedFingerprintsStorageKey) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((value) => /^[0-9a-f]{64}$/i.test(value)) : []);
  } catch {
    return new Set();
  }
}

if (isDesktopNativeRadio) {
  document.title = "bitchat — Desktop";
  const platformTag = $(".preview-tag");
  if (platformTag) platformTag.textContent = "desktop";
  channelMetadata.mesh.system = "Canal mesh BitChat · transport Bluetooth Windows et chiffrement Noise";
}
const existingClientID = sessionStorage.getItem("bitchat-preview-client-id");
const clientID = forceNewIdentity || !existingClientID ? crypto.randomUUID() : existingClientID;
sessionStorage.setItem("bitchat-preview-client-id", clientID);

const initialNickname = participantParameter
  ?? sessionStorage.getItem("bitchat-preview-nickname")
  ?? localStorage.getItem("bitchat-preview-nickname")
  ?? "anonymous";

if (participantParameter || instanceParameter) {
  history.replaceState(null, "", window.location.pathname);
}

const state = {
  clientID,
  nickname: normalizeNickname(initialNickname),
  theme: localStorage.getItem("bitchat-preview-theme") === "matrix" ? "matrix" : "glass",
  mode: localStorage.getItem("bitchat-preview-mode") === "light" ? "light" : "dark",
  currentConversation: "mesh",
  localPeople: [],
  externalPeople: new Map(),
  people: [],
  messages: [],
  unread: new Map(),
  readReceiptsSent: new Set(),
  verifiedFingerprints: loadVerifiedFingerprints(),
  reply: null,
  connected: false,
  recording: false,
  recordingBusy: false,
  recordingStartedAt: 0,
  recordingTimer: null,
  recordingMaximumTimer: null,
  favoriteFilter: "all",
  toastTimer: null,
  bluetooth: {
    status: WebBluetoothMeshAdapter.isSupported ? "disabled" : "unsupported",
    connected: false,
    canTransmit: false,
    deviceName: null,
    peerCount: 0,
    network: localStorage.getItem("bitchat-web-ble-network") ?? "mainnet"
  },
  nostr: {
    status: "disabled",
    connected: false,
    relayURL: localStorage.getItem("bitchat-web-nostr-relay")
      ?? NostrGeohashAdapter.defaultRelays[0],
    geohash: localStorage.getItem("bitchat-web-nostr-geohash") ?? "u33dc",
    publicKey: null
  }
};

const voiceNoteRecorder = new VoiceNoteRecorder();

sessionStorage.setItem("bitchat-preview-nickname", state.nickname);
const realtimeClient = new RealtimeChatClient({
  clientID: state.clientID,
  nickname: state.nickname
});
const meshIdentity = await loadMeshIdentity({
  storage: sessionStorage,
  storageKey: `bitchat-web-native-identity-v1:${state.clientID}`
});
const bluetoothAdapter = new WebBluetoothMeshAdapter({
  identity: meshIdentity,
  nickname: state.nickname,
  onStatus(status) {
    state.bluetooth = { ...state.bluetooth, ...status };
    updateOptionalConnectivityUI();
  },
  onPeer: upsertExternalPeer,
  onPeerRemoved: removeExternalPeer,
  onMessage: acceptExternalMessage,
  onDelivery: acceptExternalDelivery,
  onVerification({ peer, fingerprint, verified }) {
    if (!verified || !fingerprint) return;
    state.verifiedFingerprints.add(fingerprint);
    localStorage.setItem(
      verifiedFingerprintsStorageKey,
      JSON.stringify([...state.verifiedFingerprints])
    );
    upsertExternalPeer({ ...peer, verified: true });
    const status = $("#verificationScanStatus");
    if (status) status.textContent = `Identité @${peer.nickname} vérifiée`;
    showToast(`Identité @${peer.nickname} vérifiée`);
  },
  onError: reportOptionalTransportError
});
const nostrAdapter = new NostrGeohashAdapter({
  identityStorageKey: `bitchat-web-nostr-identity-v1:${state.clientID}`,
  nickname: state.nickname,
  senderPeerID: meshIdentity.peerID,
  onStatus(status) {
    state.nostr = { ...state.nostr, ...status };
    channelMetadata.geo.title = `#${state.nostr.geohash}`;
    channelMetadata.geo.placeholder = `Message public dans #${state.nostr.geohash}`;
    updateOptionalConnectivityUI();
  },
  onPeer: upsertExternalPeer,
  onPeerRemoved: removeExternalPeer,
  onMessage: acceptExternalMessage,
  onDelivery: acceptExternalDelivery,
  onError: reportOptionalTransportError
});

function icon(name, className = "") {
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeNickname(value) {
  return InputValidator.validateNickname(String(value ?? "").replace(/^@+/, "")) ?? "anonymous";
}

function initialsFor(value) {
  return normalizeNickname(value)
    .replace(/[_.-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "AN";
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function bluetoothCanTransmit() {
  return state.bluetooth.connected
    && (!isDesktopNativeRadio || Boolean(state.bluetooth.canTransmit));
}

function currentBluetoothRouteAvailable() {
  if (!bluetoothCanTransmit()) return false;
  if (state.currentConversation === "mesh") return true;
  if (!isPrivateConversation(state.currentConversation)) return false;
  return personByID(otherParticipantID(state.currentConversation))?.transport === "bluetooth";
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error("Lecture du média impossible"));
    reader.readAsDataURL(blob);
  });
}

function avatarClass(personOrIndex) {
  const index = typeof personOrIndex === "number"
    ? personOrIndex
    : Number(personOrIndex?.avatarIndex ?? 0);
  return avatarClasses[Math.abs(index) % avatarClasses.length];
}

function personByID(personID) {
  return state.people.find((person) => person.id === personID);
}

function mergePeople(localPeople = state.localPeople) {
  state.localPeople = Array.isArray(localPeople) ? localPeople : [];
  const localIDs = new Set(state.localPeople.map((person) => person.id));
  state.people = [
    ...state.localPeople,
    ...[...state.externalPeople.values()].filter((person) => !localIDs.has(person.id))
  ];
}

function upsertExternalPeer(peer) {
  if (!peer?.id || !peer.nickname) return;
  const existing = state.externalPeople.get(peer.id);
  const enriched = {
    ...existing,
    ...peer,
    verified: Boolean(
      peer.verified
      || (peer.fingerprint && state.verifiedFingerprints.has(peer.fingerprint))
    )
  };
  state.externalPeople.set(peer.id, enriched);
  mergePeople();
  renderHeader();
  renderConversationNav();
  renderPeople();
  updateConnectionUI();
}

function removeExternalPeer(peer) {
  if (!peer?.id) return;
  state.externalPeople.delete(peer.id);
  mergePeople();
  renderHeader();
  renderConversationNav();
  renderPeople();
  updateConnectionUI();
}

function transportLabel(person) {
  if (person?.transport === "bluetooth") {
    const transport = person.noiseState === "established" ? "Bluetooth · Noise établi" : "Bluetooth · à portée";
    return person.verified ? `${transport} · vérifié` : transport;
  }
  if (person?.transport === "nostr") return "Nostr · relais Internet";
  return "serveur local · actif maintenant";
}

function acceptExternalMessage(envelope) {
  if (!envelope?.id || state.messages.some((message) => message.id === envelope.id)) return;
  const conversationID = envelope.isPrivate
    ? createPrivateConversationID(state.clientID, envelope.authorId)
    : envelope.conversationId;
  if (!conversationID) return;
  const coreMessage = createBitchatMessage({
    id: envelope.id,
    sender: envelope.sender,
    content: envelope.content,
    timestamp: envelope.timestamp,
    isPrivate: Boolean(envelope.isPrivate),
    recipientNickname: envelope.isPrivate ? state.nickname : null,
    senderPeerID: envelope.authorId,
    isBridged: envelope.transport === "nostr",
    acceptHistoricalTimestamp: Boolean(envelope.acceptHistoricalTimestamp)
  });
  if (!coreMessage) return;
  const message = {
    ...withDeliveryStatus(coreMessage, DeliveryStatusKind.delivered),
    conversationId: conversationID,
    participantIds: envelope.isPrivate ? participantIDsForConversation(conversationID) : [],
    authorId: envelope.authorId,
    type: envelope.type ?? "text",
    image: envelope.image ?? null,
    audio: envelope.audio ?? null,
    fileData: envelope.fileData ?? null,
    fileName: envelope.fileName ?? null,
    mimeType: envelope.mimeType ?? null,
    duration: envelope.duration ?? (envelope.type === "voice" ? "Audio" : null),
    quote: null,
    transport: envelope.transport,
    transportMessageID: envelope.supportsReceipts === false
      ? null
      : envelope.transportMessageID ?? envelope.id
  };
  state.messages.push(message);
  if (conversationID !== state.currentConversation) {
    state.unread.set(conversationID, (state.unread.get(conversationID) ?? 0) + 1);
  }
  renderConversationNav();
  renderPeople();
  if (conversationID === state.currentConversation) renderMessages();
  if (envelope.isPrivate && conversationID === state.currentConversation) {
    window.setTimeout(() => sendExternalReadReceipts(conversationID), 0);
  }
}

const deliveryStatusRank = Object.freeze({
  [DeliveryStatusKind.sending]: 0,
  [DeliveryStatusKind.sent]: 1,
  [DeliveryStatusKind.carried]: 2,
  [DeliveryStatusKind.partiallyDelivered]: 2,
  [DeliveryStatusKind.delivered]: 3,
  [DeliveryStatusKind.read]: 4,
  [DeliveryStatusKind.failed]: -1
});

function acceptExternalDelivery({ id, status, transport }) {
  if (!id || ![DeliveryStatusKind.delivered, DeliveryStatusKind.read].includes(status)) return;
  const messageIndex = state.messages.findIndex((message) => (
    message.id === id
    && message.authorId === state.clientID
    && (transport === "noise"
      ? message.transport === "noise"
      : message.transport?.startsWith("nostr"))
  ));
  if (messageIndex < 0) return;
  const message = state.messages[messageIndex];
  const current = message.deliveryStatus?.kind ?? DeliveryStatusKind.sent;
  if ((deliveryStatusRank[status] ?? 0) <= (deliveryStatusRank[current] ?? 0)) return;
  state.messages[messageIndex] = withDeliveryStatus(message, status, { at: Date.now() });
  renderConversationNav();
  if (message.conversationId === state.currentConversation) {
    renderMessages({ preserveScroll: true });
  }
}

async function sendExternalReadReceipts(conversationID) {
  if (!isPrivateConversation(conversationID)) return;
  const person = personByID(otherParticipantID(conversationID));
  if (!person) return;
  const incoming = state.messages.filter((message) => (
    message.conversationId === conversationID
    && message.authorId === person.id
    && message.transportMessageID
    && (message.transport === "noise" || message.transport === "nostr")
  ));
  for (const message of incoming) {
    const receiptKey = `${message.transport}:${message.transportMessageID}`;
    if (state.readReceiptsSent.has(receiptKey)) continue;
    const operation = message.transport === "noise" && bluetoothCanTransmit()
      ? bluetoothAdapter.sendReadReceipt(person.id, message.transportMessageID)
      : message.transport === "nostr" && state.nostr.connected
        ? nostrAdapter.publishReadReceipt(person.pubkey, message.transportMessageID)
        : null;
    if (!operation) continue;
    state.readReceiptsSent.add(receiptKey);
    try {
      await operation;
    } catch (error) {
      state.readReceiptsSent.delete(receiptKey);
      reportOptionalTransportError(error);
    }
  }
}

function reportOptionalTransportError(error) {
  if (!error || error.name === "NotFoundError") return;
  showToast(error.message ?? "Erreur du transport optionnel");
}

function otherPeople() {
  return state.people.filter((person) => person.id !== state.clientID);
}

function otherParticipantID(conversationID) {
  return participantIDsForConversation(conversationID).find((id) => id !== state.clientID) ?? null;
}

function identityFromMessages(personID) {
  const message = [...state.messages].reverse().find((candidate) => candidate.authorId === personID);
  if (!message) return null;
  return {
    id: personID,
    nickname: message.sender,
    avatarIndex: Math.abs(personID.length + message.sender.length) % avatarClasses.length
  };
}

function channelTransportState(conversationID) {
  if (!isDesktopNativeRadio) {
    return state.connected
      ? { kind: "active", label: "Actif", active: true }
      : { kind: "offline", label: "Hors ligne", active: false };
  }

  const transport = conversationID === "geo" ? state.nostr : state.bluetooth;
  if (conversationID === "mesh" && transport.connected && !bluetoothCanTransmit()) {
    return { kind: "waiting", label: "En attente", active: false };
  }
  if (transport.connected) return { kind: "active", label: "Actif", active: true };
  return {
    connecting: { kind: "connecting", label: "Connexion…", active: false },
    error: { kind: "error", label: "Erreur", active: false },
    disconnected: { kind: "offline", label: "Hors ligne", active: false },
    unsupported: { kind: "unsupported", label: "Indisponible", active: false },
    disabled: { kind: "disabled", label: "Désactivé", active: false }
  }[transport.status] ?? { kind: "disabled", label: "Désactivé", active: false };
}

function conversationMetadata(conversationID = state.currentConversation) {
  if (channelMetadata[conversationID]) {
    const otherCount = otherPeople().length;
    const transportState = channelTransportState(conversationID);
    const desktopSubtitle = conversationID === "mesh"
      ? `Bluetooth BitChat · ${transportState.label.toLocaleLowerCase("fr")}`
      : `Nostr #${state.nostr.geohash} · ${transportState.label.toLocaleLowerCase("fr")}`;
    return {
      ...channelMetadata[conversationID],
      subtitle: isDesktopNativeRadio
        ? desktopSubtitle
        : conversationID === "mesh"
          ? `${otherCount} autre${otherCount === 1 ? "" : "s"} participant${otherCount === 1 ? "" : "s"} connecté${otherCount === 1 ? "" : "s"}`
          : `Canal local · ${state.people.length} participant${state.people.length === 1 ? "" : "s"}`,
      count: otherCount
    };
  }

  const otherID = otherParticipantID(conversationID);
  const person = personByID(otherID) ?? identityFromMessages(otherID) ?? {
    id: otherID,
    nickname: "participant",
    avatarIndex: 0
  };
  const online = Boolean(personByID(otherID));

  return {
    title: person.nickname,
    subtitle: online
      ? transportLabel(person)
      : "hors ligne · livraison à la prochaine connexion",
    placeholder: `Message privé à @${person.nickname}`,
    icon: "person",
    person,
    count: online ? 1 : 0,
    system: person.transport === "bluetooth"
      ? "Conversation privée chiffrée avec Noise XX sur le lien Bluetooth"
      : person.transport === "nostr"
        ? "Conversation privée via l’enveloppe propriétaire BitChat sur le relais Nostr"
        : isDesktopNativeRadio
          ? "Conversation privée locale"
          : "Conversation privée de test · transport local en temps réel"
  };
}

function currentMessages() {
  return state.messages
    .filter((message) => message.conversationId === state.currentConversation)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function directConversationIDs() {
  const IDs = new Set();
  for (const message of state.messages) {
    if (message.conversationId?.startsWith("dm:")
      && participantIDsForConversation(message.conversationId).includes(state.clientID)) {
      IDs.add(message.conversationId);
    }
  }
  if (state.currentConversation.startsWith("dm:")) IDs.add(state.currentConversation);
  return [...IDs].sort((left, right) => {
    const leftTime = state.messages.findLast((message) => message.conversationId === left)?.timestamp ?? 0;
    const rightTime = state.messages.findLast((message) => message.conversationId === right)?.timestamp ?? 0;
    return rightTime - leftTime;
  });
}

function applyAppearance() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.mode = state.mode;
  document.documentElement.style.colorScheme = state.mode;

  const modeIcon = state.mode === "dark" ? "sun" : "moon";
  $(".mode-icon use", elements.modeButton)?.setAttribute("href", `#i-${modeIcon}`);
  elements.modeButton.setAttribute(
    "aria-label",
    state.mode === "dark" ? "Passer au mode clair" : "Passer au mode sombre"
  );

  const themeColor = state.mode === "dark"
    ? (state.theme === "matrix" ? "#020703" : "#080b12")
    : (state.theme === "matrix" ? "#fbfff9" : "#eef2f9");
  $('meta[name="theme-color"]').setAttribute("content", themeColor);
}

function updateProfile() {
  elements.profileNickname.textContent = `@${state.nickname}`;
  const textNode = [...elements.profileInitials.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
  if (textNode) textNode.nodeValue = initialsFor(state.nickname);
  sessionStorage.setItem("bitchat-preview-nickname", state.nickname);
  if (!forceNewIdentity) localStorage.setItem("bitchat-preview-nickname", state.nickname);
}

function updateConnectionUI() {
  const bluetoothReady = state.bluetooth.connected;
  const bluetoothActive = bluetoothCanTransmit();
  const nativeLinks = [
    bluetoothActive ? "BLE" : null,
    state.nostr.connected ? "Nostr" : null
  ].filter(Boolean);
  const anyConnection = isDesktopNativeRadio
    ? nativeLinks.length > 0 || bluetoothReady
    : state.connected || nativeLinks.length > 0;
  elements.connectionChip.classList.toggle("connected", anyConnection);
  elements.connectionChip.classList.toggle("disconnected", !anyConnection);
  elements.connectionLabel.textContent = isDesktopNativeRadio
    ? (nativeLinks.length ? nativeLinks.join(" + ") : bluetoothReady ? "BLE prêt" : "transports inactifs")
    : state.connected
      ? (nativeLinks.length ? `local + ${nativeLinks.join(" + ")}` : "serveur local")
      : (nativeLinks.length ? nativeLinks.join(" + ") : "reconnexion…");
  elements.meshStatusTitle.textContent = nativeLinks.length
    ? `Transport ${nativeLinks.join(" + ")} actif`
    : isDesktopNativeRadio && bluetoothReady
      ? "Bluetooth prêt · téléphone attendu"
      : isDesktopNativeRadio ? "Transports désactivés" : state.connected ? "Serveur local actif" : "Serveur indisponible";
  elements.meshStatusDetail.textContent = isDesktopNativeRadio
    ? (nativeLinks.length
      ? `${state.people.length} identité${state.people.length === 1 ? "" : "s"} · historique local`
      : bluetoothReady
        ? "Ouvrez BitChat sur le téléphone pour établir l’abonnement GATT"
        : "Activez Bluetooth ou Nostr dans les réglages")
    : state.connected
      ? `${state.people.length} participant${state.people.length === 1 ? "" : "s"} · historique persistant`
      : nativeLinks.length ? "Le transport natif reste disponible" : "Tentative de reconnexion…";
  elements.meshStatusPill.textContent = nativeLinks.length
    ? nativeLinks.join("+").toLowerCase()
    : isDesktopNativeRadio && bluetoothReady ? "en attente" : isDesktopNativeRadio ? "inactif" : state.connected ? "direct" : "hors ligne";

  const externalPerson = isPrivateConversation(state.currentConversation)
    ? personByID(otherParticipantID(state.currentConversation))
    : null;
  const optionalSendAvailable = (state.currentConversation === "mesh" && bluetoothActive)
    || (state.currentConversation === "geo" && state.nostr.connected)
    || (externalPerson?.transport === "bluetooth" && bluetoothActive)
    || (externalPerson?.transport === "nostr" && state.nostr.connected);
  const externalConversation = externalPerson?.transport === "bluetooth"
    || externalPerson?.transport === "nostr";
  const canSend = isDesktopNativeRadio
    ? optionalSendAvailable
    : externalConversation ? optionalSendAvailable : state.connected || optionalSendAvailable;
  elements.messageInput.disabled = !canSend;
  elements.attachButton.disabled = isDesktopNativeRadio ? !currentBluetoothRouteAvailable() : !state.connected;
  elements.sendButton.disabled = !canSend;
}

function renderHeader() {
  const conversation = conversationMetadata();
  elements.headerTitle.textContent = conversation.title;
  elements.headerSubtitle.textContent = conversation.subtitle;
  elements.peopleCount.textContent = otherPeople().length;
  elements.messageInput.placeholder = conversation.placeholder;
  elements.messageInput.maxLength = isPrivateConversation(state.currentConversation)
    ? CoreLimits.privateMessageUTF8Bytes
    : CoreLimits.publicMessageUTF8Bytes;

  if (conversation.icon === "person") {
    const person = conversation.person;
    elements.headerSymbol.innerHTML = `
      <span class="avatar ${avatarClass(person)}">
        ${escapeHTML(initialsFor(person.nickname))}
        <span class="presence ${personByID(person.id) ? "online" : "away"}"></span>
      </span>`;
  } else {
    elements.headerSymbol.innerHTML = icon(conversation.icon);
  }

  elements.composerHint.innerHTML = state.currentConversation === "mesh"
    ? bluetoothCanTransmit()
      ? `${icon("radio")} Bluetooth BitChat actif · messages transmis au mesh natif.`
      : state.bluetooth.connected && isDesktopNativeRadio
        ? `${icon("radio")} Bluetooth prêt · ouvrez BitChat sur le téléphone pour envoyer.`
      : isDesktopNativeRadio
        ? `${icon("radio")} Bluetooth BitChat désactivé · activez-le dans les réglages.`
        : `${icon("radio")} Temps réel local · Bluetooth peut être activé dans les réglages.`
    : state.currentConversation === "geo"
      ? state.nostr.connected
        ? `${icon("globe")} Relais Nostr ${escapeHTML(state.nostr.relayURL)} · geohash ${escapeHTML(state.nostr.geohash)}.`
        : isDesktopNativeRadio
          ? `${icon("globe")} Nostr désactivé · activez le relais dans les réglages.`
          : `${icon("globe")} Canal local · Nostr peut être activé explicitement dans les réglages.`
      : conversation.person?.transport === "bluetooth"
        ? `${icon("shield")} Message privé chiffré par Noise_XX_25519_ChaChaPoly_SHA256.`
        : conversation.person?.transport === "nostr"
          ? `${icon("shield")} Enveloppe BitChat XChaCha20-Poly1305 14/13/1059 sur Nostr.`
          : `${icon("shield")} ${isDesktopNativeRadio ? "Conversation privée locale." : "Conversation privée entre ces deux identités de test."}`;
}

function previewForConversation(conversationID) {
  const lastMessage = state.messages.findLast((message) => message.conversationId === conversationID);
  if (!lastMessage) {
    if (isDesktopNativeRadio) {
      const transportState = channelTransportState(conversationID);
      const transport = conversationID === "mesh" ? "Bluetooth" : "Nostr";
      return `Aucun message · ${transport} ${transportState.label.toLocaleLowerCase("fr")}`;
    }
    return conversationID === "mesh" ? "Aucun message · serveur local" : "Aucun message";
  }
  if (lastMessage.type === "voice") return "🎙 Message vocal";
  if (lastMessage.type === "image") return "🖼 Image";
  if (lastMessage.type === "file") return `📎 ${lastMessage.fileName ?? "Fichier"}`;
  return `${lastMessage.sender}: ${lastMessage.content}`;
}

function renderConversationNav() {
  const directIDs = directConversationIDs();
  const channelStates = new Map(["mesh", "geo"].map((conversationID) => [
    conversationID,
    channelTransportState(conversationID)
  ]));
  const channelRows = ["mesh", "geo"].map((conversationID) => {
    const metadata = conversationMetadata(conversationID);
    const unread = state.unread.get(conversationID) ?? 0;
    const transportState = channelStates.get(conversationID);
    return `
      <button class="conversation-item channel-${transportState.kind} ${state.currentConversation === conversationID ? "active" : ""}" type="button" data-conversation="${conversationID}" aria-label="${escapeHTML(metadata.title)}, ${transportState.label}">
        <span class="conversation-icon ${conversationID === "mesh" ? "mesh-icon" : "geo-icon"}">${icon(metadata.icon)}</span>
        <span class="conversation-copy">
          <span class="conversation-title">${escapeHTML(metadata.title)}</span>
          <span class="conversation-preview">${escapeHTML(previewForConversation(conversationID))}</span>
        </span>
        <span class="channel-meta">
          ${unread ? `<span class="unread-badge">${unread}</span>` : ""}
          <span class="channel-state channel-state-${transportState.kind}">${transportState.label}</span>
        </span>
      </button>`;
  }).join("");
  const activeChannelCount = [...channelStates.values()].filter((transport) => transport.active).length;

  const directRows = directIDs.map((conversationID) => {
    const metadata = conversationMetadata(conversationID);
    const unread = state.unread.get(conversationID) ?? 0;
    const online = Boolean(personByID(metadata.person.id));
    return `
      <button class="conversation-item ${state.currentConversation === conversationID ? "active" : ""}" type="button" data-conversation="${escapeHTML(conversationID)}">
        <span class="avatar ${avatarClass(metadata.person)}">
          ${escapeHTML(initialsFor(metadata.person.nickname))}
          <span class="presence ${online ? "online" : "away"}"></span>
        </span>
        <span class="conversation-copy">
          <span class="conversation-title">${escapeHTML(metadata.person.nickname)}</span>
          <span class="conversation-preview">${escapeHTML(previewForConversation(conversationID))}</span>
        </span>
        ${unread ? `<span class="unread-badge">${unread}</span>` : `<span class="conversation-time">${online ? "en ligne" : "hors ligne"}</span>`}
      </button>`;
  }).join("");

  elements.conversationNav.innerHTML = `
    <section class="nav-section">
      <div class="section-heading"><span>Canaux</span><span class="section-count">${isDesktopNativeRadio ? `${activeChannelCount} actif${activeChannelCount === 1 ? "" : "s"}` : "2"}</span></div>
      ${channelRows}
    </section>
    <section class="nav-section">
      <div class="section-heading"><span>Messages privés</span><span class="section-count">${directIDs.length}</span></div>
      ${directRows || `
        <div class="nav-empty">
          Ouvrez « Personnes » puis choisissez un participant.
        </div>`}
    </section>`;

  filterConversationNav();
}

function voiceBars(seed = "") {
  const numericSeed = [...String(seed)].reduce((total, character) => total + character.charCodeAt(0), 0);
  return Array.from({ length: 34 }, (_, index) => {
    const height = 5 + ((index * 7 + numericSeed) % 17);
    return `<i style="--wave-height:${height}px"></i>`;
  }).join("");
}

function deliveryIndicator(message) {
  const kind = message.deliveryStatus?.kind ?? DeliveryStatusKind.sent;
  const labels = {
    [DeliveryStatusKind.sending]: "Envoi en cours",
    [DeliveryStatusKind.sent]: "Envoyé",
    [DeliveryStatusKind.carried]: "Transporté",
    [DeliveryStatusKind.partiallyDelivered]: "Partiellement livré",
    [DeliveryStatusKind.delivered]: "Livré",
    [DeliveryStatusKind.read]: "Lu",
    [DeliveryStatusKind.failed]: "Échec de l’envoi"
  };
  const label = labels[kind] ?? "Envoyé";
  return `<span class="delivery-indicator delivery-${escapeHTML(kind)}" title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}">${icon("checks")}</span>`;
}

function renderMessage(message, previousMessage) {
  const mine = message.authorId === state.clientID;
  const compact = previousMessage
    && previousMessage.authorId === message.authorId
    && previousMessage.type !== "system";
  const person = personByID(message.authorId);
  const authorIndex = person?.avatarIndex ?? Math.abs(message.authorId.length + message.sender.length) % avatarClasses.length;
  const body = message.type === "voice"
    ? message.audio
      ? `<audio class="voice-audio" controls preload="none" src="${escapeHTML(message.audio)}"></audio>`
      : `
      <div class="voice-message">
        <button class="voice-play" type="button" data-action="play" aria-label="Lire le message vocal"></button>
        <div class="voice-track">${voiceBars(message.id)}</div>
        <span class="voice-duration">${escapeHTML(message.duration)}</span>
      </div>`
    : `
      ${message.image ? `<img class="message-image" src="${escapeHTML(message.image)}" alt="Image envoyée par ${escapeHTML(message.sender)}">` : ""}
      ${message.fileData ? `<a class="file-attachment" href="${escapeHTML(message.fileData)}" download="${escapeHTML(message.fileName ?? "fichier")}">📎 <span>${escapeHTML(message.fileName ?? "Fichier")}</span></a>` : ""}
      ${message.quote ? `
        <div class="quoted-message">
          <span><strong>${escapeHTML(message.quote.author)}</strong><br>${escapeHTML(message.quote.text)}</span>
        </div>` : ""}
      ${message.type === "text" && message.content ? `<p>${escapeHTML(message.content)}</p>` : ""}`;
  const time = formatTime(message.timestamp);
  const transportBadge = message.transport === "bluetooth"
    ? "BLE"
    : message.transport === "noise"
      ? "Noise"
      : message.transport === "nostr" || message.transport === "nostr-private"
        ? "Nostr"
        : "";

  return `
    <article class="message-row ${mine ? "mine" : ""} ${compact ? "compact" : ""}" data-message-id="${escapeHTML(message.id)}">
      ${mine ? "" : `<span class="avatar ${avatarClass(authorIndex)}">${escapeHTML(initialsFor(message.sender))}</span>`}
      <div class="message-stack" style="--author-color:${authorColors[authorIndex % authorColors.length]}">
        ${compact || mine ? "" : `
          <div class="message-author">
            <strong>@${escapeHTML(message.sender)}</strong>
            <time>${time}</time>
          </div>`}
        <div class="message-bubble">
          ${body}
          <span class="message-meta">${transportBadge ? `<em>${transportBadge}</em>` : ""}${time}${mine ? deliveryIndicator(message) : ""}</span>
        </div>
      </div>
      <div class="message-actions" aria-label="Actions du message">
        <button type="button" data-action="reply" title="Répondre">${icon("reply")}</button>
        <button type="button" data-action="more" title="Plus d’options">${icon("dots")}</button>
      </div>
    </article>`;
}

function renderMessages({ preserveScroll = false } = {}) {
  const messages = currentMessages();
  const nearBottom = isNearBottom();
  const metadata = conversationMetadata();

  if (messages.length === 0) {
    const emptyDescription = isDesktopNativeRadio
      ? state.currentConversation === "geo"
        ? "Aucun contenu de démonstration n’est chargé. Activez Nostr pour utiliser ce canal geohash."
        : state.currentConversation === "mesh"
          ? "Aucun contenu de démonstration n’est chargé. Activez Bluetooth puis envoyez un message depuis un appareil BitChat à portée."
          : "Aucun message privé n’est enregistré dans cette conversation."
      : "Les données ne sont plus préremplies. Envoyez un message ou ouvrez une seconde identité pour commencer un échange réel entre deux fenêtres.";
    elements.messageList.innerHTML = `
      <div class="empty-conversation">
        <span class="empty-icon">${icon(metadata.icon === "person" ? "users" : metadata.icon)}</span>
        <h3>Aucun message dans ${escapeHTML(metadata.title)}</h3>
        <p>${emptyDescription}</p>
        ${isDesktopNativeRadio ? "" : '<button type="button" data-open-test-participant>Ouvrir un participant de test</button>'}
      </div>`;
  } else {
    elements.messageList.innerHTML = [
      `<div class="date-divider"><span>Aujourd’hui</span></div>`,
      `<div class="system-message">${escapeHTML(metadata.system)}</div>`,
      ...messages.map((message, index) => renderMessage(message, messages[index - 1]))
    ].join("");
  }

  if (!preserveScroll || nearBottom) requestAnimationFrame(scrollToBottom);
}

function renderPeople() {
  const allOthers = otherPeople();
  const visible = state.favoriteFilter === "favorites" ? [] : allOthers;

  elements.rangeSummaryTitle.textContent = `${state.people.length} participant${state.people.length === 1 ? "" : "s"} connecté${state.people.length === 1 ? "" : "s"}`;
  elements.rangeSummaryDetail.textContent = "Présence locale en temps réel";

  elements.peopleList.innerHTML = visible.length
    ? visible.map((person) => `
        <button class="person-row" type="button" data-person-id="${escapeHTML(person.id)}">
          <span class="avatar ${avatarClass(person)}">${escapeHTML(initialsFor(person.nickname))}<span class="presence online"></span></span>
          <span class="person-copy">
            <strong>@${escapeHTML(person.nickname)}</strong>
            <span>${escapeHTML(transportLabel(person))}</span>
          </span>
          <span class="person-meta">·</span>
        </button>`).join("")
    : `
      <div class="empty-conversation">
        <span class="empty-icon">${icon("users")}</span>
        <h3>${state.favoriteFilter === "favorites" ? "Aucun favori" : "Aucun autre participant"}</h3>
        <p>${state.favoriteFilter === "favorites"
          ? "Aucune identité vérifiée n’est enregistrée dans cette vue."
          : isDesktopNativeRadio
            ? "Les appareils BitChat détectés par Bluetooth apparaîtront ici."
            : "Ouvrez une autre identité pour tester la présence et les messages privés."}</p>
        ${!isDesktopNativeRadio && state.favoriteFilter === "all" ? `<button type="button" data-open-test-participant>Ouvrir un participant</button>` : ""}
      </div>`;
}

function renderAll({ preserveScroll = false } = {}) {
  updateConnectionUI();
  renderHeader();
  renderConversationNav();
  renderPeople();
  renderMessages({ preserveScroll });
}

function selectConversation(conversationID) {
  if (!channelMetadata[conversationID] && !conversationID.startsWith("dm:")) return;
  state.currentConversation = conversationID;
  state.unread.delete(conversationID);
  state.reply = null;
  cancelRecording(false);
  updateReplyPreview();
  renderAll();
  elements.appShell.classList.remove("sidebar-open");
  if (window.innerWidth <= 1180) elements.appShell.classList.remove("details-open");
  elements.liveRegion.textContent = `Conversation ${conversationMetadata().title} ouverte`;
  void sendExternalReadReceipts(conversationID);
}

function openDirectConversation(personID) {
  if (!personID || personID === state.clientID) return;
  const conversationID = createPrivateConversationID(state.clientID, personID);
  if (conversationID) selectConversation(conversationID);
}

function updateComposerState() {
  const hasText = elements.messageInput.value.trim().length > 0;
  elements.sendButton.classList.toggle("has-text", hasText && !state.recording);
  elements.sendButton.classList.toggle("recording", state.recording);
  elements.sendButton.setAttribute(
    "aria-label",
    state.recording ? "Arrêter et envoyer l’enregistrement" : hasText ? "Envoyer le message" : "Enregistrer un message vocal"
  );
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 120)}px`;
}

async function announcePresence() {
  try {
    realtimeClient.setNickname(state.nickname);
    await realtimeClient.announcePresence();
    setConnected(true);
  } catch {
    setConnected(false);
  }
}

function setConnected(connected) {
  if (state.connected === connected) return;
  state.connected = connected;
  updateConnectionUI();
  renderHeader();
}

function connectRealtime() {
  realtimeClient.connect({
    onConnection: setConnected,
    onSnapshot(snapshot) {
      mergePeople(Array.isArray(snapshot.people) ? snapshot.people : []);
      const externalMessages = state.messages.filter((message) => message.transport);
      const localMessages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
      const localIDs = new Set(localMessages.map((message) => message.id));
      state.messages = [
        ...localMessages,
        ...externalMessages.filter((message) => !localIDs.has(message.id))
      ];
      setConnected(true);
      renderAll();
    },
    onPresence(update) {
      mergePeople(Array.isArray(update.people) ? update.people : []);
      renderHeader();
      renderConversationNav();
      renderPeople();
      updateConnectionUI();
    },
    onMessage({ message }) {
      if (!message || state.messages.some((candidate) => candidate.id === message.id)) return;
      state.messages.push(message);
      if (message.conversationId !== state.currentConversation && message.authorId !== state.clientID) {
        state.unread.set(message.conversationId, (state.unread.get(message.conversationId) ?? 0) + 1);
      }
      renderConversationNav();
      if (message.conversationId === state.currentConversation) renderMessages();
    },
    onReset() {
      state.messages = state.messages.filter((message) => message.transport);
      state.unread.clear();
      renderAll();
      showToast("Historique local effacé");
    }
  });
}

function addOutgoingExternalMessage({
  id,
  timestamp,
  content,
  transport,
  recipient,
  type = "text",
  image = null,
  audio = null,
  fileData = null,
  fileName = null,
  mimeType = null,
  duration = null
}) {
  const coreMessage = createBitchatMessage({
    id,
    sender: state.nickname,
    content,
    timestamp,
    isPrivate: Boolean(recipient),
    recipientNickname: recipient?.nickname ?? null,
    senderPeerID: state.clientID,
    deliveryStatus: { kind: DeliveryStatusKind.sent },
    isBridged: transport.startsWith("nostr")
  });
  if (!coreMessage) return;
  state.messages.push({
    ...coreMessage,
    conversationId: state.currentConversation,
    participantIds: recipient ? participantIDsForConversation(state.currentConversation) : [],
    authorId: state.clientID,
    type,
    image,
    audio,
    fileData,
    fileName,
    mimeType,
    duration,
    quote: null,
    transport
  });
  renderConversationNav();
  renderMessages();
}

async function postMessage(payload) {
  const isText = payload.type === "text";
  const { nativeFile, ...localPayload } = payload;
  const privateConversation = isPrivateConversation(state.currentConversation);
  const recipient = privateConversation
    ? personByID(otherParticipantID(state.currentConversation))
    : null;
  const externalPrivate = recipient?.transport === "bluetooth" || recipient?.transport === "nostr";
  const operations = [];

  if (state.connected && !isDesktopNativeRadio && !externalPrivate && payload.type !== "file") {
    operations.push({
      name: "local",
      promise: realtimeClient.sendMessage({
        idempotencyKey: crypto.randomUUID(),
        conversationId: state.currentConversation,
        ...localPayload
      })
    });
  }

  if (isText && state.currentConversation === "mesh" && bluetoothCanTransmit()) {
    operations.push({
      name: "bluetooth",
      promise: bluetoothAdapter.sendPublicMessage(payload.text)
    });
  }
  if (nativeFile && state.currentConversation === "mesh" && bluetoothCanTransmit()) {
    operations.push({
      name: "bluetooth-file",
      promise: bluetoothAdapter.sendFile(null, nativeFile)
    });
  }
  if (isText && state.currentConversation === "geo" && state.nostr.connected) {
    operations.push({
      name: "nostr",
      promise: nostrAdapter.publishMessage(payload.text)
    });
  }
  if (isText && recipient?.transport === "bluetooth" && bluetoothCanTransmit()) {
    operations.push({
      name: "noise",
      promise: bluetoothAdapter.sendPrivateMessage(recipient.id, payload.text)
    });
  }
  if (nativeFile && recipient?.transport === "bluetooth" && bluetoothCanTransmit()) {
    operations.push({
      name: "noise-file",
      promise: bluetoothAdapter.sendFile(recipient.id, nativeFile)
    });
  }
  if (isText && recipient?.transport === "nostr" && state.nostr.connected) {
    operations.push({
      name: "nostr-private",
      promise: nostrAdapter.publishPrivateMessage(recipient.pubkey, payload.text)
    });
  }
  if (!operations.length) {
    showToast(isText
      ? "Aucun transport actif pour cette conversation"
      : "Aucun transport compatible avec ce média n’est actif");
    return;
  }

  const results = await Promise.allSettled(operations.map((operation) => operation.promise));
  let displayed = false;
  let succeeded = 0;
  let lastError = null;
  results.forEach((result, index) => {
    const operation = operations[index];
    if (result.status === "rejected") {
      lastError = result.reason;
      return;
    }
    succeeded += 1;
    if (operation.name === "local" && result.value.message
      && !state.messages.some((message) => message.id === result.value.message.id)) {
      state.messages.push(result.value.message);
      displayed = true;
    }
  });

  if (!displayed) {
    const externalIndex = operations.findIndex((operation, index) => (
      operation.name !== "local" && results[index].status === "fulfilled"
    ));
    if (externalIndex >= 0) {
      const outcome = results[externalIndex].value;
      addOutgoingExternalMessage({
        id: outcome.id,
        timestamp: outcome.timestamp,
        content: payload.text ?? nativeFile?.fileName ?? "Fichier",
        transport: operations[externalIndex].name,
        recipient,
        type: payload.type,
        image: payload.image ?? null,
        audio: payload.audio ?? null,
        fileData: payload.fileData ?? null,
        fileName: nativeFile?.fileName ?? null,
        mimeType: nativeFile?.mimeType ?? null,
        duration: payload.duration ?? null
      });
      displayed = true;
    }
  }

  if (displayed) {
    renderConversationNav();
    renderMessages();
  }
  if (!succeeded) {
    showToast(`Envoi impossible : ${lastError?.message ?? "transport indisponible"}`);
  } else if (succeeded < operations.length) {
    showToast(`Message envoyé sur ${succeeded}/${operations.length} transport(s)`);
  }
}

async function sendTextMessage() {
  const rawText = elements.messageInput.value;
  if (!rawText.trim()) {
    void startRecording();
    return;
  }

  const privateMessage = isPrivateConversation(state.currentConversation);
  const text = privateMessage
    ? InputValidator.validatePrivateMessage(rawText)
    : InputValidator.validatePublicMessage(rawText);
  if (!text) {
    const maximum = privateMessage
      ? CoreLimits.privateMessageUTF8Bytes
      : CoreLimits.publicMessageUTF8Bytes;
    showToast(`Message invalide ou supérieur à ${maximum} octets UTF-8`);
    return;
  }

  const quote = state.reply ? { author: state.reply.author, text: state.reply.text } : null;
  elements.messageInput.value = "";
  state.reply = null;
  updateReplyPreview();
  updateComposerState();
  await postMessage({ type: "text", text, quote });
}

async function addAttachmentMessage(file) {
  if (!file) return;
  const isImage = file.type.startsWith("image/");
  const isAudio = file.type.startsWith("audio/");
  const usesBluetooth = currentBluetoothRouteAvailable();
  let prepared = {
    blob: file,
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    optimized: false
  };

  if (isImage && usesBluetooth) {
    prepared = await optimizeImageForTransfer(file, {
      maximumBytes: BitChatFileTransferLimits.maximumImageBytes
    });
  }

  const maximumBytes = isImage
    ? usesBluetooth ? BitChatFileTransferLimits.maximumImageBytes : WebFeatureLimits.imageFileBytes
    : isAudio
      ? BitChatFileTransferLimits.maximumVoiceNoteBytes
      : BitChatFileTransferLimits.maximumPayloadBytes;
  if (!prepared.blob.size || prepared.blob.size > maximumBytes) {
    throw new Error(`${isImage ? "Image" : isAudio ? "Audio" : "Fichier"} trop volumineux — maximum ${Math.floor(maximumBytes / 1024)} Ko`);
  }

  const dataURL = await blobToDataURL(prepared.blob);
  const content = new Uint8Array(await prepared.blob.arrayBuffer());
  if (prepared.optimized) {
    showToast(`Image optimisée : ${Math.ceil(file.size / 1024)} → ${Math.ceil(content.length / 1024)} Ko`);
  }
  await postMessage({
    type: isImage ? "image" : isAudio ? "voice" : "file",
    image: isImage ? dataURL : null,
    audio: isAudio ? dataURL : null,
    fileData: isImage || isAudio ? null : dataURL,
    duration: isAudio ? "Audio" : null,
    text: prepared.fileName,
    nativeFile: {
      fileName: prepared.fileName,
      mimeType: prepared.mimeType,
      content
    }
  });
}

async function startRecording() {
  if (state.recordingBusy) return;
  if (state.recording) {
    await finishRecording();
    return;
  }
  if (!currentBluetoothRouteAvailable()) {
    showToast("Connectez d’abord un téléphone BitChat pour envoyer une note vocale");
    return;
  }

  state.recordingBusy = true;
  try {
    await voiceNoteRecorder.start();
    state.recording = true;
    state.recordingStartedAt = Date.now();
    elements.recordingPreview.classList.add("visible");
    elements.recordingTime.textContent = "0:00";
    updateComposerState();
    state.recordingTimer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - state.recordingStartedAt) / 1000);
      elements.recordingTime.textContent = formatDuration(seconds);
    }, 250);
    state.recordingMaximumTimer = window.setTimeout(() => void finishRecording(), 120_000);
  } catch (error) {
    showToast(error?.name === "NotAllowedError"
      ? "Microphone refusé · autorisez-le dans les paramètres Windows"
      : error.message ?? "Enregistrement audio impossible");
  } finally {
    state.recordingBusy = false;
  }
}

async function finishRecording() {
  if (!state.recording || state.recordingBusy) return;
  state.recordingBusy = true;
  try {
    const voice = await voiceNoteRecorder.stop();
    clearRecordingState();
    if (!voice?.blob.size) throw new Error("La note vocale est vide");
    if (voice.blob.size > BitChatFileTransferLimits.maximumVoiceNoteBytes) {
      throw new Error(`Note vocale trop volumineuse — maximum ${Math.floor(BitChatFileTransferLimits.maximumVoiceNoteBytes / 1024)} Ko`);
    }
    const content = new Uint8Array(await voice.blob.arrayBuffer());
    await postMessage({
      type: "voice",
      audio: await blobToDataURL(voice.blob),
      duration: formatDuration(voice.durationSeconds),
      text: voice.fileName,
      nativeFile: {
        fileName: voice.fileName,
        mimeType: voice.mimeType,
        content
      }
    });
  } catch (error) {
    clearRecordingState();
    showToast(error.message ?? "Envoi de la note vocale impossible");
  } finally {
    state.recordingBusy = false;
  }
}

function cancelRecording(showMessage = false) {
  void voiceNoteRecorder.cancel().catch(reportOptionalTransportError);
  clearRecordingState();
  if (showMessage) showToast("Enregistrement annulé");
}

function clearRecordingState() {
  if (state.recordingTimer) clearInterval(state.recordingTimer);
  if (state.recordingMaximumTimer) clearTimeout(state.recordingMaximumTimer);
  state.recordingTimer = null;
  state.recordingMaximumTimer = null;
  state.recording = false;
  elements.recordingPreview.classList.remove("visible");
  updateComposerState();
}

function updateReplyPreview() {
  elements.replyPreview.classList.toggle("visible", Boolean(state.reply));
  if (!state.reply) return;
  elements.replyAuthor.textContent = `Répondre à @${state.reply.author}`;
  elements.replyText.textContent = state.reply.text;
}

function replyToMessage(messageID) {
  const message = state.messages.find((candidate) => candidate.id === messageID);
  if (!message) return;
  state.reply = {
    author: message.sender,
    text: message.type === "voice"
      ? "Message vocal"
      : message.type === "image"
        ? "Image"
        : message.type === "file"
          ? message.fileName ?? "Fichier"
          : message.content
  };
  updateReplyPreview();
  elements.messageInput.focus();
}

function isNearBottom() {
  return elements.messageStage.scrollHeight - elements.messageStage.scrollTop - elements.messageStage.clientHeight < 90;
}

function scrollToBottom() {
  elements.messageStage.scrollTo({
    top: elements.messageStage.scrollHeight,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
  });
  elements.jumpButton.classList.remove("visible");
}

function togglePeoplePanel(force) {
  const open = typeof force === "boolean" ? force : !elements.appShell.classList.contains("details-open");
  elements.appShell.classList.toggle("details-open", open);
  if (open) {
    elements.appShell.classList.remove("sidebar-open");
    renderPeople();
  }
}

let activeModalCleanup = null;

function openModal({ eyebrow, title, content, onOpen, onClose }) {
  activeModalCleanup?.();
  activeModalCleanup = onClose ?? null;
  elements.modalEyebrow.textContent = eyebrow;
  elements.modalTitle.textContent = title;
  elements.modalContent.innerHTML = content;
  elements.modalLayer.classList.add("open");
  elements.modalLayer.setAttribute("aria-hidden", "false");
  onOpen?.();
  requestAnimationFrame(() => $(".modal-card button, .modal-card input")?.focus());
}

function closeModal() {
  activeModalCleanup?.();
  activeModalCleanup = null;
  elements.modalLayer.classList.remove("open");
  elements.modalLayer.setAttribute("aria-hidden", "true");
}

function openIdentityVerification() {
  let scannerControls = null;
  let scannerRun = 0;
  let refreshTimer = null;
  let closed = false;

  const stopScanner = () => {
    scannerRun += 1;
    scannerControls?.stop();
    scannerControls = null;
  };
  const stopRefresh = () => {
    clearInterval(refreshTimer);
    refreshTimer = null;
  };
  const cleanup = () => {
    closed = true;
    stopScanner();
    stopRefresh();
  };

  openModal({
    eyebrow: "Vérification d’identité",
    title: "Code QR",
    content: `
      <div class="verification-tabs" role="tablist" aria-label="Vérification QR">
        <button class="selected" type="button" data-verification-tab="mine">Mon QR</button>
        <button type="button" data-verification-tab="scan">Scanner</button>
      </div>
      <div class="verification-content" id="verificationContent"></div>`,
    onClose: cleanup,
    onOpen: () => {
      const selectTab = (name) => {
        $$('[data-verification-tab]', elements.modalContent).forEach((button) => {
          button.classList.toggle("selected", button.dataset.verificationTab === name);
        });
        if (name === "scan") showVerificationScanner();
        else showMyVerificationQR();
      };

      const showMyVerificationQR = async () => {
        stopScanner();
        stopRefresh();
        const content = $("#verificationContent");
        if (!content) return;
        content.innerHTML = `
          <div class="verification-qr-state">
            <span class="qr-loading" aria-hidden="true"></span>
            <p>Création du QR signé…</p>
          </div>`;
        try {
          const value = buildVerificationQR({ identity: meshIdentity, nickname: state.nickname });
          const imageURL = await QRCode.toDataURL(value, {
            errorCorrectionLevel: "M",
            margin: 2,
            width: 320,
            color: { dark: "#05070c", light: "#ffffff" }
          });
          if (closed || !$("#verificationContent")) return;
          content.innerHTML = `
            <div class="verification-qr-card">
              <img src="${imageURL}" alt="Code QR signé de @${escapeHTML(state.nickname)}">
            </div>
            <strong class="verification-nickname">@${escapeHTML(state.nickname)}</strong>
            <p class="verification-help">Scannez ce code avec BitChat Android. Il expire après cinq minutes et ne contient aucune clé privée.</p>
            <span class="verification-security">${icon("shield")} Identité signée Ed25519 · vérification par Noise</span>`;
        } catch (error) {
          content.innerHTML = `<div class="preview-warning">${icon("info")}<p>${escapeHTML(error.message ?? "QR indisponible")}</p></div>`;
        }
        refreshTimer = window.setInterval(showMyVerificationQR, 60_000);
      };

      const showVerificationScanner = async () => {
        stopRefresh();
        stopScanner();
        const content = $("#verificationContent");
        if (!content) return;
        content.innerHTML = `
          <div class="verification-scanner-frame">
            <video id="verificationVideo" muted playsinline></video>
            <span class="scanner-target" aria-hidden="true"></span>
          </div>
          <p class="verification-help" id="verificationScanStatus">Autorisez la caméra puis présentez le QR BitChat du téléphone.</p>`;
        const video = $("#verificationVideo");
        const status = $("#verificationScanStatus");
        try {
          const run = scannerRun;
          const reader = new BrowserQRCodeReader(undefined, {
            delayBetweenScanAttempts: 250,
            delayBetweenScanSuccess: 1_000
          });
          const controls = await reader.decodeFromVideoDevice(undefined, video, async (result, error, activeControls) => {
            if (!result || closed || run !== scannerRun) return;
            const qr = parseAndVerifyVerificationQR(result.getText());
            if (!qr) {
              if (status) status.textContent = "QR BitChat invalide, expiré ou non signé.";
              return;
            }
            activeControls.stop();
            scannerControls = null;
            scannerRun += 1;
            if (status) status.textContent = "QR valide · établissement de la vérification Noise…";
            try {
              const peer = await bluetoothAdapter.verifyScannedIdentity(qr);
              if (status) status.textContent = `Challenge sécurisé envoyé à @${peer.nickname}…`;
            } catch (verificationError) {
              if (status) status.textContent = verificationError.message ?? "Vérification impossible";
            }
          });
          if (closed || run !== scannerRun) controls.stop();
          else scannerControls = controls;
        } catch (error) {
          if (status) status.textContent = error?.name === "NotAllowedError"
            ? "Accès caméra refusé. Autorisez la caméra dans Windows puis réessayez."
            : `Caméra indisponible : ${error.message ?? "erreur inconnue"}`;
        }
      };

      $$('[data-verification-tab]', elements.modalContent).forEach((button) => {
        button.addEventListener("click", () => selectTab(button.dataset.verificationTab));
      });
      void showMyVerificationQR();
    }
  });
}

function optionalStatusLabel(status) {
  return {
    connected: "connecté",
    connecting: "connexion…",
    disconnected: "déconnecté",
    unsupported: "non supporté",
    error: "erreur",
    disabled: "désactivé"
  }[status] ?? status;
}

function bluetoothStatusLabel() {
  if (!isDesktopNativeRadio || !state.bluetooth.connected) {
    return optionalStatusLabel(state.bluetooth.status);
  }
  return bluetoothCanTransmit()
    ? `${state.bluetooth.peerCount} téléphone${state.bluetooth.peerCount === 1 ? "" : "s"}`
    : "prêt · en attente";
}

function updateOptionalConnectivityUI() {
  updateConnectionUI();
  renderHeader();
  renderConversationNav();
  renderPeople();

  const bluetoothStatus = $("#bluetoothFeatureStatus");
  const bluetoothButton = $("#bluetoothFeatureButton");
  if (bluetoothStatus) bluetoothStatus.textContent = bluetoothStatusLabel();
  if (bluetoothButton) {
    bluetoothButton.textContent = state.bluetooth.connected ? "Déconnecter" : "Connecter";
    bluetoothButton.disabled = state.bluetooth.status === "connecting"
      || state.bluetooth.status === "unsupported";
  }

  const nostrStatus = $("#nostrFeatureStatus");
  const nostrButton = $("#nostrFeatureButton");
  if (nostrStatus) nostrStatus.textContent = optionalStatusLabel(state.nostr.status);
  if (nostrButton) {
    nostrButton.textContent = state.nostr.connected ? "Déconnecter" : "Connecter";
    nostrButton.disabled = state.nostr.status === "connecting";
  }
}

function openSettings() {
  openModal({
    eyebrow: "Préférences locales",
    title: "Réglages",
    content: `
      <section class="settings-section">
        <label class="settings-label" for="nicknameSetting">${isDesktopNativeRadio ? "Identité Desktop" : "Identité de cette fenêtre"}</label>
        <div class="identity-input">
          <span>@</span>
          <input id="nicknameSetting" type="text" maxlength="${CoreLimits.nicknameCharacters}" value="${escapeHTML(state.nickname)}" autocomplete="off">
        </div>
      </section>
      ${isDesktopNativeRadio ? "" : `<section class="settings-section">
        <span class="settings-label">Test multi-utilisateur</span>
        <div class="test-participant-card">
          ${icon("users")}
          <div><strong>Nouvelle identité</strong><span>Ouvre une autre fenêtre connectée au même serveur</span></div>
          <button class="primary-action" id="openParticipantButton" type="button">Ouvrir</button>
        </div>
      </section>`}
      <section class="settings-section">
        <span class="settings-label">Thème</span>
        <div class="theme-grid">
          <button class="theme-card ${state.theme === "glass" ? "selected" : ""}" type="button" data-theme-choice="glass">
            <strong>Liquid Glass</strong><span>Moderne et translucide</span>
            <span class="theme-demo glass"><i></i><i></i></span>
          </button>
          <button class="theme-card ${state.theme === "matrix" ? "selected" : ""}" type="button" data-theme-choice="matrix">
            <strong>Matrix</strong><span>Terminal historique</span>
            <span class="theme-demo matrix"><i></i><i></i></span>
          </button>
        </div>
      </section>
      <section class="settings-section">
        <span class="settings-label">Apparence</span>
        <div class="segmented-control">
          <button class="${state.mode === "light" ? "selected" : ""}" type="button" data-mode-choice="light">Clair</button>
          <button class="${state.mode === "dark" ? "selected" : ""}" type="button" data-mode-choice="dark">Sombre</button>
        </div>
      </section>
      <section class="settings-section">
        <span class="settings-label">Données dynamiques</span>
        <div class="settings-row">
          <span class="settings-row-copy"><strong>Serveur temps réel</strong><span>${state.connected ? "Connecté" : "Reconnexion en cours"}</span></span>
          <span class="status-pill">${state.connected ? "actif" : "hors ligne"}</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-copy"><strong>Historique local</strong><span>${state.messages.length} message${state.messages.length === 1 ? "" : "s"} persistant${state.messages.length === 1 ? "" : "s"}</span></span>
          <button class="danger-action" id="resetHistoryButton" type="button">Effacer</button>
        </div>
      </section>
      <section class="settings-section">
        <span class="settings-label">Transports BitChat optionnels</span>
        <div class="native-feature-card">
          <div class="native-feature-heading">
            <span class="icon-wrap">${icon("radio")}</span>
            <span><strong>Bluetooth + Noise</strong><small>${isDesktopNativeRadio ? "Nœud GATT natif Windows et relais multi-pair" : "Connexion GATT centrale vers une app BitChat native"}</small></span>
            <span class="status-pill" id="bluetoothFeatureStatus">${bluetoothStatusLabel()}</span>
          </div>
          <div class="native-feature-controls">
            <label>
              <span>Réseau</span>
              <select id="bluetoothNetworkSetting">
                <option value="mainnet" ${state.bluetooth.network === "mainnet" ? "selected" : ""}>Production</option>
                <option value="testnet" ${state.bluetooth.network === "testnet" ? "selected" : ""}>Debug / testnet</option>
              </select>
            </label>
            <button class="primary-action" id="bluetoothFeatureButton" type="button" ${state.bluetooth.status === "unsupported" ? "disabled" : ""}>
              ${state.bluetooth.connected ? "Déconnecter" : "Connecter"}
            </button>
          </div>
          <p>${isDesktopNativeRadio
            ? "Windows annonce le service BitChat natif. Les téléphones abonnés échangent les trames via le même codec, Noise et moteur de relais que le Web Core."
            : "Edge ou Chrome est requis. Le navigateur se connecte à un pair qui sert de passerelle ; il ne peut pas annoncer lui-même le service BLE."}</p>
        </div>
        <div class="native-feature-card">
          <div class="native-feature-heading">
            <span class="icon-wrap">${icon("globe")}</span>
            <span><strong>Nostr BitChat</strong><small>Geohash public et enveloppes privées natives</small></span>
            <span class="status-pill" id="nostrFeatureStatus">${optionalStatusLabel(state.nostr.status)}</span>
          </div>
          <div class="native-feature-fields">
            <label>
              <span>Relais sécurisé</span>
              <input id="nostrRelaySetting" type="url" value="${escapeHTML(state.nostr.relayURL)}" spellcheck="false">
            </label>
            <label>
              <span>Geohash</span>
              <input id="nostrGeohashSetting" type="text" value="${escapeHTML(state.nostr.geohash)}" maxlength="12" spellcheck="false">
            </label>
            <button class="primary-action" id="nostrFeatureButton" type="button">
              ${state.nostr.connected ? "Déconnecter" : "Connecter"}
            </button>
          </div>
          <p>La connexion révèle votre adresse IP au relais. Les messages privés utilisent le format propriétaire BitChat 14/13/1059, compatible avec les fixtures iOS et Android du projet.</p>
        </div>
      </section>`,
    onOpen: bindSettingsControls
  });
}

function bindSettingsControls() {
  const nicknameInput = $("#nicknameSetting");
  nicknameInput?.addEventListener("change", async () => {
    const nickname = InputValidator.validateNickname(nicknameInput.value.replace(/^@+/, ""));
    if (!nickname) {
      nicknameInput.value = state.nickname;
      showToast(`Pseudo invalide — maximum ${CoreLimits.nicknameCharacters} caractères, sans contrôle`);
      return;
    }
    state.nickname = nickname;
    nicknameInput.value = state.nickname;
    updateProfile();
    nostrAdapter.setNickname(state.nickname);
    bluetoothAdapter.setNickname(state.nickname).catch(reportOptionalTransportError);
    await announcePresence();
    renderAll({ preserveScroll: true });
    showToast(`Identité mise à jour : @${state.nickname}`);
  });

  $("#openParticipantButton")?.addEventListener("click", openTestParticipant);
  $("#bluetoothFeatureButton")?.addEventListener("click", async () => {
    if (state.bluetooth.connected) {
      bluetoothAdapter.disconnect();
      return;
    }
    const network = $("#bluetoothNetworkSetting")?.value ?? "mainnet";
    state.bluetooth.network = network;
    localStorage.setItem("bitchat-web-ble-network", network);
    try {
      await bluetoothAdapter.connect({ network });
      showToast(isDesktopNativeRadio
        ? "Nœud mesh Bluetooth Windows activé"
        : `Bluetooth connecté à ${state.bluetooth.deviceName ?? "BitChat"}`);
    } catch (error) {
      if (error?.name !== "NotFoundError") showToast(error.message ?? "Connexion Bluetooth impossible");
    }
  });

  $("#nostrFeatureButton")?.addEventListener("click", async () => {
    if (state.nostr.connected) {
      nostrAdapter.disconnect();
      return;
    }
    const relayURL = $("#nostrRelaySetting")?.value ?? state.nostr.relayURL;
    const geohash = $("#nostrGeohashSetting")?.value ?? state.nostr.geohash;
    try {
      await nostrAdapter.connect({ relayURL, geohash });
      state.nostr.relayURL = nostrAdapter.relayURL;
      state.nostr.geohash = nostrAdapter.geohash;
      localStorage.setItem("bitchat-web-nostr-relay", state.nostr.relayURL);
      localStorage.setItem("bitchat-web-nostr-geohash", state.nostr.geohash);
      showToast(`Nostr connecté à ${state.nostr.relayURL}`);
    } catch (error) {
      showToast(error.message ?? "Connexion Nostr impossible");
    }
  });

  $("#resetHistoryButton")?.addEventListener("click", async () => {
    if (!window.confirm(isDesktopNativeRadio
      ? "Effacer tout l’historique local du Desktop ?"
      : "Effacer tout l’historique du simulateur Web local ?")) return;
    await realtimeClient.resetHistory();
    closeModal();
  });

  $$("[data-theme-choice]", elements.modalContent).forEach((button) => {
    button.addEventListener("click", () => {
      state.theme = button.dataset.themeChoice;
      localStorage.setItem("bitchat-preview-theme", state.theme);
      applyAppearance();
      $$("[data-theme-choice]", elements.modalContent).forEach((choice) => choice.classList.toggle("selected", choice === button));
    });
  });

  $$("[data-mode-choice]", elements.modalContent).forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.modeChoice;
      localStorage.setItem("bitchat-preview-mode", state.mode);
      applyAppearance();
      $$("[data-mode-choice]", elements.modalContent).forEach((choice) => choice.classList.toggle("selected", choice === button));
    });
  });
}

function openTestParticipant() {
  if (isDesktopNativeRadio) return;
  const usedNames = new Set(state.people.map((person) => person.nickname.toLocaleLowerCase("fr")));
  const baseName = testNames.find((name) => !usedNames.has(name.toLocaleLowerCase("fr"))) ?? `Test${state.people.length + 1}`;
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("participant", baseName);
  url.searchParams.set("instance", crypto.randomUUID());
  const testWindow = window.open(url, "_blank");
  if (!testWindow) {
    showToast("Autorisez les fenêtres contextuelles pour ouvrir un participant");
  } else {
    testWindow.opener = null;
    showToast(`Participant @${baseName} ouvert`);
  }
}

function openChannelPicker() {
  const content = ["mesh", "geo"].map((conversationID) => {
    const metadata = conversationMetadata(conversationID);
    return `
      <button class="channel-picker-item" type="button" data-channel-choice="${conversationID}">
        <span class="icon-wrap">${icon(metadata.icon)}</span>
        <span><strong>${escapeHTML(metadata.title)}</strong><span>${escapeHTML(metadata.subtitle)}</span></span>
        <span class="checkmark">${state.currentConversation === conversationID ? "✓" : ""}</span>
      </button>`;
  }).join("");

  openModal({
    eyebrow: "Changer d’espace",
    title: "Canaux dynamiques",
    content: `<div class="channel-picker-list">${content}</div>`,
    onOpen: () => {
      $$("[data-channel-choice]", elements.modalContent).forEach((button) => {
        button.addEventListener("click", () => {
          selectConversation(button.dataset.channelChoice);
          closeModal();
        });
      });
    }
  });
}

function openNotices() {
  openModal({
    eyebrow: "Messages persistants",
    title: "Avis épinglés",
    content: `
      <div class="empty-conversation">
        <span class="empty-icon">${icon("pin")}</span>
        <h3>Aucun avis dynamique</h3>
        <p>${isDesktopNativeRadio ? "Aucun avis n’est enregistré sur ce Desktop." : "Les anciens avis de démonstration ont été retirés avec les données statiques."}</p>
      </div>`
  });
  $(".notification-dot", elements.noticesButton)?.remove();
}

function openAbout() {
  openModal({
    eyebrow: "À propos",
    title: isDesktopNativeRadio ? "bitchat/ desktop" : "bitchat/ web",
    content: `
      <div class="about-hero">
        <span class="about-mark">${icon("radio")}</span>
        <div><h3>${isDesktopNativeRadio ? "Nœud BitChat Windows" : "Simulateur dynamique"}</h3><p>${isDesktopNativeRadio ? "Transport BLE natif et cœur Web réutilisable" : "Interface SwiftUI adaptée au navigateur"}</p></div>
      </div>
      <div class="preview-warning">
        ${icon("info")}
        <p><strong>Transport local par défaut, interopérabilité native optionnelle.</strong>Bluetooth, Noise et Nostr ne démarrent qu’après une action explicite dans les réglages.</p>
      </div>
      <div class="feature-grid">
        <div class="feature-tile">${icon("users")}<strong>Présence en direct</strong><span>${state.people.length} identité${state.people.length === 1 ? "" : "s"} active${state.people.length === 1 ? "" : "s"}</span></div>
        <div class="feature-tile">${icon("send")}<strong>Messages réels</strong><span>Synchronisés entre onglets</span></div>
        <div class="feature-tile">${icon("shield")}<strong>Noise XX</strong><span>${state.bluetooth.connected ? "Disponible pour les DM BLE" : "Désactivé"}</span></div>
        <div class="feature-tile">${icon("globe")}<strong>Nostr</strong><span>${state.nostr.connected ? escapeHTML(state.nostr.geohash) : "Désactivé"}</span></div>
      </div>`
  });
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toastText.textContent = message;
  elements.toast.classList.add("visible");
  state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

function filterConversationNav() {
  const query = elements.conversationSearch.value.trim().toLocaleLowerCase("fr");
  $$(".conversation-item", elements.conversationNav).forEach((item) => {
    item.hidden = query && !item.textContent.toLocaleLowerCase("fr").includes(query);
  });
}

function positionEmojiPopover() {
  if (!elements.emojiButton) return;
  const rectangle = elements.emojiButton.getBoundingClientRect();
  const width = 166;
  elements.emojiPopover.style.left = `${Math.min(window.innerWidth - width - 12, Math.max(12, rectangle.right - width))}px`;
  elements.emojiPopover.style.top = `${Math.max(12, rectangle.top - 92)}px`;
}

function toggleEmojiPopover(force) {
  if (!elements.emojiButton) return;
  const open = typeof force === "boolean" ? force : !elements.emojiPopover.classList.contains("open");
  if (open) positionEmojiPopover();
  elements.emojiPopover.classList.toggle("open", open);
  elements.emojiPopover.setAttribute("aria-hidden", String(!open));
}

elements.composerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.recording) void finishRecording();
  else void sendTextMessage();
});

elements.messageInput.addEventListener("input", updateComposerState);
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendTextMessage();
  }
});

elements.attachButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", async () => {
  try {
    await addAttachmentMessage(elements.fileInput.files?.[0]);
  } catch (error) {
    showToast(error.message ?? "Lecture du fichier impossible");
  }
  elements.fileInput.value = "";
});

elements.cancelReplyButton.addEventListener("click", () => {
  state.reply = null;
  updateReplyPreview();
});

elements.messageList.addEventListener("click", (event) => {
  if (event.target.closest("[data-open-test-participant]")) {
    openTestParticipant();
    return;
  }
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const messageID = actionButton.closest("[data-message-id]")?.dataset.messageId;
  if (actionButton.dataset.action === "reply") replyToMessage(messageID);
  if (actionButton.dataset.action === "more") showToast("Menu de message à compléter");
  if (actionButton.dataset.action === "play") {
    actionButton.classList.toggle("playing");
    showToast(actionButton.classList.contains("playing") ? "Lecture audio simulée" : "Lecture arrêtée");
  }
});

elements.conversationNav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-conversation]");
  if (button) selectConversation(button.dataset.conversation);
});

elements.peopleList.addEventListener("click", (event) => {
  if (event.target.closest("[data-open-test-participant]")) {
    openTestParticipant();
    return;
  }
  const button = event.target.closest("[data-person-id]");
  if (button) openDirectConversation(button.dataset.personId);
});

$$(".people-filter button").forEach((button) => {
  button.addEventListener("click", () => {
    state.favoriteFilter = button.dataset.filter;
    $$(".people-filter button").forEach((choice) => choice.classList.toggle("active", choice === button));
    renderPeople();
  });
});

elements.conversationSearch.addEventListener("input", filterConversationNav);
elements.menuButton.addEventListener("click", () => {
  elements.appShell.classList.toggle("sidebar-open");
  elements.appShell.classList.remove("details-open");
});
elements.mobileBackdrop.addEventListener("click", () => elements.appShell.classList.remove("sidebar-open", "details-open"));
elements.peopleButton.addEventListener("click", () => togglePeoplePanel());
elements.verificationButton?.addEventListener("click", openIdentityVerification);
elements.closeDetailsButton.addEventListener("click", () => togglePeoplePanel(false));
elements.channelPickerButton.addEventListener("click", openChannelPicker);
elements.noticesButton.addEventListener("click", openNotices);
elements.settingsButton.addEventListener("click", openSettings);
elements.profileButton.addEventListener("click", openSettings);
elements.infoButton.addEventListener("click", openAbout);

elements.modeButton.addEventListener("click", () => {
  state.mode = state.mode === "dark" ? "light" : "dark";
  localStorage.setItem("bitchat-preview-mode", state.mode);
  applyAppearance();
  showToast(state.mode === "dark" ? "Mode sombre activé" : "Mode clair activé");
});

elements.jumpButton.addEventListener("click", scrollToBottom);
elements.messageStage.addEventListener("scroll", () => elements.jumpButton.classList.toggle("visible", !isNearBottom()));
elements.emojiButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleEmojiPopover();
});

elements.emojiPopover.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  elements.messageInput.setRangeText(
    button.textContent,
    elements.messageInput.selectionStart,
    elements.messageInput.selectionEnd,
    "end"
  );
  elements.messageInput.focus();
  updateComposerState();
  toggleEmojiPopover(false);
});

elements.modalLayer.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-modal]")) closeModal();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#emojiPopover, #emojiButton")) toggleEmojiPopover(false);
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (window.innerWidth <= 850) elements.appShell.classList.add("sidebar-open");
    elements.conversationSearch.focus();
  }
  if (event.key === "Escape") {
    if (state.recording) cancelRecording(true);
    closeModal();
    toggleEmojiPopover(false);
    elements.appShell.classList.remove("sidebar-open", "details-open");
  }
});

window.addEventListener("resize", () => {
  toggleEmojiPopover(false);
  if (window.innerWidth > 850) elements.appShell.classList.remove("sidebar-open");
});

window.addEventListener("pagehide", () => {
  cancelRecording(false);
  realtimeClient.disconnect();
  bluetoothAdapter.disconnect();
  nostrAdapter.disconnect();
});

applyAppearance();
updateProfile();
updateConnectionUI();
renderHeader();
updateComposerState();

await announcePresence();
connectRealtime();
setInterval(announcePresence, 10_000);
setInterval(() => {
  nostrAdapter.publishPresence().catch(reportOptionalTransportError);
}, 60_000);
