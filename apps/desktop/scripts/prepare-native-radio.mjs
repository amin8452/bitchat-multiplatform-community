import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const project = resolve(desktopRoot, "native-windows", "Bitchat.Windows.Radio.csproj");
const output = resolve(desktopRoot, "runtime", "native-windows");

await mkdir(output, { recursive: true });
await new Promise((resolvePromise, reject) => {
  const child = spawn("dotnet", [
    "publish",
    project,
    "--configuration", "Release",
    "--runtime", "win-x64",
    "--self-contained", "true",
    "--output", output,
    "-p:PublishSingleFile=true",
    "-p:DebugType=None",
    "-p:DebugSymbols=false"
  ], { stdio: "inherit", windowsHide: true });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`Native radio publish failed with exit code ${code}`));
  });
});

console.log(`Windows BLE radio prepared: ${output}`);
