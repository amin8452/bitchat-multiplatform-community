import { build } from "esbuild";

await build({
  entryPoints: ["app.js"],
  outfile: "dist/app.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome110", "edge110"],
  sourcemap: true,
  legalComments: "none"
});
