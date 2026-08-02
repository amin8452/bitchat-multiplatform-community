import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const serverPath = resolve(import.meta.dirname, "..", "server.mjs");

function startServer(port, stateFile) {
  return spawn(process.execPath, [serverPath, String(port)], {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      BITCHAT_WEB_STATE_FILE: stateFile
    },
    stdio: "ignore",
    windowsHide: true
  });
}

async function waitForServer(baseURL) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) return;
    } catch {
      // Server startup is still in progress.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Timed out waiting for preview server");
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
  server.kill();
  await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000))
  ]);
}

async function post(baseURL, path, body) {
  const response = await fetch(`${baseURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { response, payload };
}

test("server composes core rules with realtime/persistence adapters", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "bitchat-web-core-"));
  const stateFile = join(temporaryDirectory, "state.json");
  const port = 43_000 + Math.floor(Math.random() * 1_000);
  const baseURL = `http://127.0.0.1:${port}`;
  let server = startServer(port, stateFile);

  try {
    await waitForServer(baseURL);

    for (const asset of ["/", "/app.js", "/src/core/index.js", "/src/adapters/realtime-chat-client.js"]) {
      const response = await fetch(`${baseURL}${asset}`);
      assert.equal(response.status, 200, `${asset} should be served`);
    }

    const alpha = { clientId: "test-peer-alpha-001", nickname: "Alpha 🚀" };
    const beta = { clientId: "test-peer-beta-0002", nickname: "Beta" };
    assert.equal((await post(baseURL, "/api/presence", alpha)).response.status, 200);
    assert.equal((await post(baseURL, "/api/presence", beta)).response.status, 200);

    const publicRequest = {
      ...alpha,
      idempotencyKey: "public-message-0001",
      conversationId: "mesh",
      type: "text",
      text: "hello @Beta"
    };
    const firstPublic = await post(baseURL, "/api/messages", publicRequest);
    assert.equal(firstPublic.response.status, 201);
    assert.equal(firstPublic.payload.message.sender, "Alpha 🚀");
    assert.equal(firstPublic.payload.message.content, "hello @Beta");
    assert.deepEqual(firstPublic.payload.message.mentions, ["Beta"]);
    assert.equal(firstPublic.payload.message.isPrivate, false);
    assert.equal(firstPublic.payload.message.deliveryStatus.kind, "sent");

    const duplicate = await post(baseURL, "/api/messages", publicRequest);
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.payload.duplicate, true);

    const conversationId = "dm:test-peer-alpha-001:test-peer-beta-0002";
    const tooLong = await post(baseURL, "/api/messages", {
      ...alpha,
      idempotencyKey: "private-message-long",
      conversationId,
      type: "text",
      text: "a".repeat(256)
    });
    assert.equal(tooLong.response.status, 400);

    const privateMessage = await post(baseURL, "/api/messages", {
      ...alpha,
      idempotencyKey: "private-message-good",
      conversationId,
      type: "text",
      text: "a".repeat(255)
    });
    assert.equal(privateMessage.response.status, 201);
    assert.equal(privateMessage.payload.message.isPrivate, true);
    assert.equal(privateMessage.payload.message.recipientNickname, "Beta");

    const beforeRestart = await (await fetch(`${baseURL}/api/state`)).json();
    assert.equal(beforeRestart.people.length, 2);
    assert.equal(beforeRestart.messages.length, 2);

    await stopServer(server);
    server = startServer(port, stateFile);
    await waitForServer(baseURL);

    const afterRestart = await (await fetch(`${baseURL}/api/state`)).json();
    assert.equal(afterRestart.people.length, 0);
    assert.equal(afterRestart.messages.length, 2);
    assert.equal(afterRestart.messages[0].sender, "Alpha 🚀");
  } finally {
    await stopServer(server);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
