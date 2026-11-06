import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_DIRNAME, PIDFILE, STUBWAY_DIRNAME } from "./constants.js";

/** The project's stubway home (default fixtures root), e.g. <cwd>/.stubway. */
export function stubwayDir(cwd: string): string {
  return path.join(cwd, STUBWAY_DIRNAME);
}

/** Ephemeral, gitignored runtime state, e.g. <cwd>/.stubway/.local. */
export function localDir(cwd: string): string {
  return path.join(cwd, STUBWAY_DIRNAME, LOCAL_DIRNAME);
}

/**
 * The directory whose `.stubway/.local/daemon.json` describes the daemon for `cwd`: the nearest
 * ancestor holding one, so commands run from a subfolder (e.g. `backend/`) find the project's
 * daemon. The search stops at the repository root (a `.git` entry). Falls back to `cwd`.
 */
export function findProjectDir(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(localDir(dir), PIDFILE))) return dir;
    const parent = path.dirname(dir);
    if (existsSync(path.join(dir, ".git")) || parent === dir) return cwd;
    dir = parent;
  }
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
