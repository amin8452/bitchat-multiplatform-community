import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContentNormalizer,
  DeliveryStatusKind,
  InputValidator,
  MessageDeduplicator,
  MessageRateLimiter,
  WebFeatureLimits,
  createBitchatMessage,
  isPrivateConversation,
  normalizeClientID,
  normalizeConversationID,
  participantIDsForConversation,
  withDeliveryStatus
} from "./src/core/index.js";
import { JsonMessageRepository } from "./src/adapters/json-message-repository.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const runtimeStateFile = process.env.BITCHAT_WEB_STATE_FILE
  ? resolve(process.env.BITCHAT_WEB_STATE_FILE)
  : resolve(root, ".runtime", "state.json");
const portArgument = process.argv.find((argument) => /^\d+$/.test(argument));
const requestedPort = Number.parseInt(process.env.BITCHAT_WEB_PORT ?? portArgument ?? "4173", 10);
const port = Number.isFinite(requestedPort) ? requestedPort : 4173;
const shouldOpenBrowser = process.argv.includes("--open");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const presence = new Map();
const eventClients = new Set();
const messageRepository = new JsonMessageRepository(
  runtimeStateFile,
  WebFeatureLimits.persistedMessages
);
const messageDeduplicator = new MessageDeduplicator();
const messageRateLimiter = new MessageRateLimiter();
let messages = await messageRepository.load();

for (const message of messages) {
  messageDeduplicator.isDuplicate(message.id, message.timestamp);
}

function safePath(urlPath) {
  const pathname = decodeURIComponent((urlPath ?? "/").split("?")[0]);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^[/\\]+/, "");
  const absolutePath = resolve(root, relativePath);

  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    return null;
  }

  return absolutePath;
}

function cleanString(value, maximumLength) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, maximumLength);
}

function avatarIndexFor(clientID) {
  let hash = 0;
  for (const character of clientID) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % 6;
}

function publicPeople() {
  return [...presence.values()]
    .sort((left, right) => left.nickname.localeCompare(right.nickname))
    .map(({ lastSeen, ...person }) => person);
}

function snapshot() {
  return {
    kind: "snapshot",
    serverTime: Date.now(),
    people: publicPeople(),
    messages
  };
}

function sendJSON(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Bitchat-Preview": "1"
  });
  response.end(JSON.stringify(body));
}

async function readJSON(request, maximumBytes = WebFeatureLimits.requestBytes) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) {
      const error = new Error("Request is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendEvent(response, eventName, data) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(eventName, data) {
  for (const client of eventClients) {
    try {
      sendEvent(client.response, eventName, data);
    } catch {
      clearInterval(client.keepAlive);
      eventClients.delete(client);
    }
  }
}

function updatePresence(payload) {
  const clientID = normalizeClientID(payload.clientId);
  const nickname = InputValidator.validateNickname(payload.nickname);
  if (!clientID || !nickname) return null;

  const existing = presence.get(clientID);
  const person = {
    id: clientID,
    nickname,
    avatarIndex: existing?.avatarIndex ?? avatarIndexFor(clientID),
    joinedAt: existing?.joinedAt ?? Date.now(),
    lastSeen: Date.now()
  };
  presence.set(clientID, person);
  return person;
}

function makeMessage(payload) {
  const authorID = normalizeClientID(payload.clientId);
  const conversationID = normalizeConversationID(payload.conversationId);
  const type = ["text", "voice", "image"].includes(payload.type) ? payload.type : "text";
  if (!authorID || !conversationID) return null;

  const isPrivate = isPrivateConversation(conversationID);
  const nickname = InputValidator.validateNickname(payload.nickname);
  if (!nickname) return null;

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const image = type === "image" && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(payload.image ?? "")
    ? String(payload.image).slice(0, WebFeatureLimits.imageDataURLCharacters)
    : null;
  const duration = type === "voice" ? cleanString(payload.duration, 12) : null;

  if (type === "text" && !text) return null;
  if (type === "image" && !image) return null;
  if (type === "voice" && !duration) return null;

  const content = type === "text"
    ? text
    : type === "image"
      ? (text || "[image]")
      : `[voice:${duration}]`;
  const participantIDs = participantIDsForConversation(conversationID);
  const recipientID = participantIDs.find((clientID) => clientID !== authorID);
  const recipientNickname = recipientID ? presence.get(recipientID)?.nickname ?? null : null;
  const idempotencyKey = /^[a-zA-Z0-9._-]{8,100}$/.test(payload.idempotencyKey ?? "")
    ? payload.idempotencyKey
    : crypto.randomUUID();
  const coreMessage = createBitchatMessage({
    id: idempotencyKey,
    sender: nickname,
    content,
    isPrivate,
    recipientNickname,
    senderPeerID: authorID
  });
  if (!coreMessage) return null;

  const quote = payload.quote && typeof payload.quote === "object"
    ? {
        author: InputValidator.validateNickname(payload.quote.author) ?? nickname,
        text: cleanString(payload.quote.text, WebFeatureLimits.quoteCharacters)
      }
    : null;

  return {
    ...withDeliveryStatus(coreMessage, DeliveryStatusKind.sent),
    conversationId: conversationID,
    participantIds: isPrivate ? participantIDs : [],
    authorId: authorID,
    type,
    image,
    duration,
    quote
  };
}

async function handleAPI(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJSON(response, 200, {
      ok: true,
      core: "portable",
      people: presence.size,
      messages: messages.length
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJSON(response, 200, snapshot());
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Bitchat-Preview": "1"
    });
    response.write("retry: 1200\n\n");
    sendEvent(response, "snapshot", snapshot());

    const client = {
      response,
      keepAlive: setInterval(() => response.write(": keep-alive\n\n"), 15_000)
    };
    eventClients.add(client);

    request.on("close", () => {
      clearInterval(client.keepAlive);
      eventClients.delete(client);
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/presence") {
    const payload = await readJSON(request, 8_000);
    const person = updatePresence(payload);
    if (!person) {
      sendJSON(response, 400, { error: "Invalid client identity" });
      return true;
    }

    broadcast("presence", { people: publicPeople() });
    sendJSON(response, 200, { ok: true, person: { ...person, lastSeen: undefined } });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/disconnect") {
    const payload = await readJSON(request, 8_000);
    const clientID = normalizeClientID(payload.clientId);
    if (clientID) {
      presence.delete(clientID);
      broadcast("presence", { people: publicPeople() });
    }
    sendJSON(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/messages") {
    const payload = await readJSON(request);
    const person = updatePresence(payload);
    const message = makeMessage(payload);
    if (!person || !message) {
      sendJSON(response, 400, { error: "Invalid message" });
      return true;
    }

    const existing = messages.find((candidate) => candidate.id === message.id);
    if (existing) {
      sendJSON(response, 200, { ok: true, duplicate: true, message: existing });
      return true;
    }

    const contentKey = ContentNormalizer.normalizedKey(message.content);
    if (!messageRateLimiter.allow({ senderKey: message.authorId, contentKey })) {
      sendJSON(response, 429, { error: "Message rate limit exceeded" });
      return true;
    }

    if (messageDeduplicator.isDuplicate(message.id)) {
      sendJSON(response, 409, { error: "Duplicate message identifier" });
      return true;
    }

    messages.push(message);
    messages = messages.slice(-WebFeatureLimits.persistedMessages);
    await messageRepository.save(messages);
    broadcast("message", { message });
    broadcast("presence", { people: publicPeople() });
    sendJSON(response, 201, { ok: true, message });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/reset") {
    messages = [];
    messageDeduplicator.reset();
    messageRateLimiter.reset();
    await messageRepository.save(messages);
    broadcast("reset", { messages: [] });
    sendJSON(response, 200, { ok: true });
    return true;
  }

  return false;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      if (await handleAPI(request, response, url)) return;
      sendJSON(response, 404, { error: "API route not found" });
      return;
    }

    const filePath = safePath(url.pathname);
    if (!filePath) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error("Not a file");

    const body = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "X-Bitchat-Preview": "1"
    });
    response.end(body);
  } catch (error) {
    if (url.pathname.startsWith("/api/")) {
      sendJSON(response, error.statusCode ?? 500, { error: error.message ?? "Server error" });
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

function openBrowser(url) {
  const commands = {
    darwin: ["open", [url]],
    linux: ["xdg-open", [url]],
    win32: ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
  };
  const command = commands[process.platform];
  if (!command) return;

  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

server.on("error", async (error) => {
  if (error.code === "EADDRINUSE") {
    const url = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.headers.get("x-bitchat-preview") === "1") {
        console.log(`bitchat web preview is already running: ${url}`);
        if (shouldOpenBrowser) openBrowser(url);
        process.exit(0);
      }
    } catch {
      // The listener is not this preview; report the port conflict below.
    }

    console.error(`Port ${port} is already used by another application.`);
    console.error(`Run: node server.mjs ${port + 1} --open`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`bitchat dynamic web preview: ${url}`);
  console.log("Realtime presence and messages are enabled.");
  console.log("Press Ctrl+C to stop.");
  if (shouldOpenBrowser) openBrowser(url);
});

const presencePruner = setInterval(() => {
  const staleBefore = Date.now() - 35_000;
  let changed = false;

  for (const [clientID, person] of presence) {
    if (person.lastSeen < staleBefore) {
      presence.delete(clientID);
      changed = true;
    }
  }

  if (changed) broadcast("presence", { people: publicPeople() });
}, 10_000);

presencePruner.unref();
