const net = require("node:net");
const path = require("node:path");

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class PreviewRuntime {
  constructor({ utilityProcess, webRoot, stateFile, logger = console }) {
    this.utilityProcess = utilityProcess;
    this.webRoot = webRoot;
    this.stateFile = stateFile;
    this.logger = logger;
    this.child = null;
    this.url = null;
  }

  async start() {
    if (this.child) return this.url;
    const port = await reserveLocalPort();
    this.url = `http://127.0.0.1:${port}`;
    this.child = this.utilityProcess.fork(path.join(this.webRoot, "server.mjs"), [], {
      cwd: this.webRoot,
      env: {
        ...process.env,
        BITCHAT_WEB_PORT: String(port),
        BITCHAT_WEB_STATE_FILE: this.stateFile
      },
      serviceName: "BitChat local runtime",
      stdio: "pipe"
    });
    this.child.stdout?.on("data", (chunk) => this.logger.info(String(chunk).trimEnd()));
    this.child.stderr?.on("data", (chunk) => this.logger.error(String(chunk).trimEnd()));

    try {
      await this.#waitUntilHealthy();
      return this.url;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    this.child?.kill();
    this.child = null;
    this.url = null;
  }

  async #waitUntilHealthy() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.url}/api/health`);
        if (response.ok && response.headers.get("x-bitchat-preview") === "1") return;
      } catch {
        // The utility process is still starting.
      }
      await delay(100);
    }
    throw new Error("Le moteur local BitChat n'a pas démarré dans le délai prévu.");
  }
}

module.exports = { PreviewRuntime, reserveLocalPort };
