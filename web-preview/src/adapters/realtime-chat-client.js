/**
 * Browser adapter for the local HTTP + Server-Sent Events transport.
 *
 * The UI depends on this small API rather than on fetch/EventSource directly.
 */
export class RealtimeChatClient {
  constructor({ clientID, nickname }) {
    this.clientID = clientID;
    this.nickname = nickname;
    this.events = null;
  }

  setNickname(nickname) {
    this.nickname = nickname;
  }

  announcePresence() {
    return this.#request("/api/presence", {
      method: "POST",
      body: {
        clientId: this.clientID,
        nickname: this.nickname
      }
    });
  }

  connect(handlers) {
    this.events?.close();
    const events = new EventSource("/api/events");
    this.events = events;

    events.addEventListener("open", () => handlers.onConnection?.(true));
    events.addEventListener("snapshot", (event) => handlers.onSnapshot?.(JSON.parse(event.data)));
    events.addEventListener("presence", (event) => handlers.onPresence?.(JSON.parse(event.data)));
    events.addEventListener("message", (event) => handlers.onMessage?.(JSON.parse(event.data)));
    events.addEventListener("reset", (event) => handlers.onReset?.(JSON.parse(event.data)));
    events.addEventListener("error", () => handlers.onConnection?.(false));
  }

  sendMessage(message) {
    return this.#request("/api/messages", {
      method: "POST",
      body: {
        clientId: this.clientID,
        nickname: this.nickname,
        ...message
      }
    });
  }

  resetHistory() {
    return this.#request("/api/reset", { method: "POST", body: {} });
  }

  disconnect() {
    this.events?.close();
    const body = new Blob(
      [JSON.stringify({ clientId: this.clientID })],
      { type: "application/json" }
    );
    navigator.sendBeacon("/api/disconnect", body);
  }

  async #request(path, { method = "GET", body } = {}) {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    return payload;
  }
}
