import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { migrateLegacyMessage } from "../core/index.js";

/**
 * Filesystem adapter for the server's message repository port.
 *
 * The server depends only on load/save behavior. Replacing JSON with another
 * store does not affect domain rules or the browser client.
 */
export class JsonMessageRepository {
  #writeQueue = Promise.resolve();

  constructor(filePath, maximumMessages) {
    this.filePath = filePath;
    this.maximumMessages = maximumMessages;
  }

  async load() {
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(stored.messages)) return [];
      return stored.messages
        .map(migrateLegacyMessage)
        .filter(Boolean)
        .slice(-this.maximumMessages);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  save(messages) {
    const serialized = JSON.stringify({
      version: 2,
      messages: messages.slice(-this.maximumMessages)
    }, null, 2);

    this.#writeQueue = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, serialized, "utf8");
    });
    return this.#writeQueue;
  }
}
