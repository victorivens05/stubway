import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_DIRNAME, STUBWAY_DIRNAME } from "./constants.js";

/** The project's stubway home (default fixtures root), e.g. <cwd>/.stubway. */
export function stubwayDir(cwd: string): string {
  return path.join(cwd, STUBWAY_DIRNAME);
}

/** Ephemeral, gitignored runtime state, e.g. <cwd>/.stubway/.local. */
export function localDir(cwd: string): string {
  return path.join(cwd, STUBWAY_DIRNAME, LOCAL_DIRNAME);
}

/**
 * Ensure the local dir exists and that `.stubway/.gitignore` ignores it — so fixtures
 * (everything else under .stubway) are committed while runtime state never is.
 */
export function ensureLocalDir(cwd: string): string {
  const dir = localDir(cwd);
  mkdirSync(dir, { recursive: true });
  const gitignore = path.join(stubwayDir(cwd), ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, `${LOCAL_DIRNAME}/\n`);
  }
  return dir;
}
