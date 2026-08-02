import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const defaultSourceRoot = resolve(desktopRoot, "..", "..", "web-preview");
const defaultDestinationRoot = resolve(desktopRoot, "runtime", "web-preview");
const protocolContract = resolve(desktopRoot, "..", "..", "protocol-conformance", "bitchat-wire-v1.json");

const runtimeEntries = Object.freeze([
  "index.html",
  "styles.css",
  "server.mjs",
  "dist/app.js",
  "src/core",
  "src/adapters/json-message-repository.js"
]);

function assertGeneratedDestination(destinationRoot) {
  const expected = defaultDestinationRoot.toLowerCase();
  if (resolve(destinationRoot).toLowerCase() !== expected) {
    throw new Error("Refusing to replace a directory outside apps/desktop/runtime/web-preview");
  }
}

export async function prepareRuntime({
  sourceRoot = defaultSourceRoot,
  destinationRoot = defaultDestinationRoot
} = {}) {
  assertGeneratedDestination(destinationRoot);
  const stagingRoot = `${destinationRoot}.staging`;
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  try {
    for (const entry of runtimeEntries) {
      const source = resolve(sourceRoot, entry);
      await stat(source);
      await cp(source, resolve(stagingRoot, entry), { recursive: true });
    }
    await rm(destinationRoot, { recursive: true, force: true });
    await mkdir(dirname(destinationRoot), { recursive: true });
    await rename(stagingRoot, destinationRoot);
    const protocolRoot = resolve(desktopRoot, "runtime", "protocol");
    await mkdir(protocolRoot, { recursive: true });
    await cp(protocolContract, resolve(protocolRoot, "bitchat-wire-v1.json"));
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return { destinationRoot, entries: runtimeEntries };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await prepareRuntime();
  console.log(`Desktop runtime prepared: ${result.destinationRoot}`);
}
