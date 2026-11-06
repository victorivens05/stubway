import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Write one fixture file under fixturesDir at the given route/name, JSON-stringified. */
export function writeFixture(
  fixturesDir: string,
  routePath: string,
  name: string,
  content: Record<string, unknown>,
): void {
  const dir = path.join(fixturesDir, ...routePath.split("/").filter(Boolean));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(content));
}

/** Write one `.js` handler fixture under fixturesDir with the given source. */
export function writeHandler(fixturesDir: string, routePath: string, name: string, source: string): void {
  const dir = path.join(fixturesDir, ...routePath.split("/").filter(Boolean));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.js`), source);
}

/** A fresh temp directory to use as a fixtures root; caller should remove it after the test. */
export function makeTempFixturesDir(): string {
  return mkdtempSync(path.join(tmpdir(), "stubway-test-"));
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
