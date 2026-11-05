import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function readVersion(): string {
  try {
    // dist/version.js and src/version.ts both sit one level below package.json.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const version = readVersion();
