#!/usr/bin/env node
// `wrangler dev` fails if the assets directory is missing. Create a tiny stub
// index.html when the frontend has not been built yet (`npm run build`).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

if (!existsSync("dist/index.html")) {
  mkdirSync("dist", { recursive: true });
  writeFileSync(
    "dist/index.html",
    "<!doctype html><title>OwnNote</title><p>Frontend not built yet. Run <code>npm run build</code>.</p>\n",
  );
  console.log("ensure-dist: wrote stub dist/index.html");
}
