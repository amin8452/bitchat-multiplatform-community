const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createInterface } = require("node:readline");

class WindowsBleRadioHost extends EventEmitter {
  constructor({ executable, logger = console }) {
    super();
    this.executable = executable;
    this.logger = logger;
    this.process = null;
    this.nextID = 1;
    this.pending = new Map();
    this.ready = null;
  }

  async startProcess() {
    if (this.process) return this.ready;
    this.process = spawn(this.executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.process.stderr.on("data", (chunk) => this.logger.error(String(chunk).trimEnd()));
    createInterface({ input: this.process.stdout }).on("line", (line) => this.#handleLine(line));
    this.process.once("exit", (code) => this.#handleExit(code));
    this.process.once("error", (error) => this.#handleExit(null, error));
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Windows BLE radio did not start")), 10_000);
      this.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.once("fatal", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    return this.ready;
  }

  async command(operation, payload = {}) {
    await this.startProcess();
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Windows BLE command timed out: ${operation}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.process.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`);
    });
  }

  async stop() {
    if (!this.process) return;
    try {
      await this.command("shutdown");
    } catch {
      this.process?.kill();
    }
    this.process = null;
    this.ready = null;
  }

  terminate() {
    this.process?.kill();
    this.process = null;
    this.ready = null;
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.error(`Invalid Windows BLE response: ${line}`);
      return;
    }
    if (message.event) {
      if (message.event === "ready") this.emit("ready");
      this.emit("event", message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Windows BLE command failed"));
  }

  #handleExit(code, error = null) {
    const failure = error ?? new Error(`Windows BLE radio exited with code ${code}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(failure);
    }
    this.pending.clear();
    this.process = null;
    this.ready = null;
    this.emit("fatal", failure);
  }
}

module.exports = { WindowsBleRadioHost };
