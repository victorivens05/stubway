import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { explicitPort, resolvePort, resolveTarget } from "../src/commands/context.js";
import { findProjectDir } from "../src/paths.js";
import { makeTempFixturesDir, removeTempDir } from "./helpers.js";

function writePidfile(projectDir: string, port: number): void {
  const local = path.join(projectDir, ".stubway", ".local");
  mkdirSync(local, { recursive: true });
  writeFileSync(path.join(local, "daemon.json"), JSON.stringify({ pid: 1, port }));
}

function withoutStubwayPort<T>(action: () => T): T {
  const saved = process.env.STUBWAY_PORT;
  delete process.env.STUBWAY_PORT;
  try {
    return action();
  } finally {
    if (saved === undefined) delete process.env.STUBWAY_PORT;
    else process.env.STUBWAY_PORT = saved;
  }
}

test("findProjectDir finds the daemon's project from a subfolder and stops at the repo root", () => {
  const root = makeTempFixturesDir();
  try {
    const repo = path.join(root, "repo");
    const backend = path.join(repo, "backend", "src");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(backend, { recursive: true });

    writePidfile(root, 1111);
    assert.equal(findProjectDir(backend), backend);

    writePidfile(repo, 3610);
    assert.equal(findProjectDir(backend), repo);
  } finally {
    removeTempDir(root);
  }
});

test("resolvePort: --port, then STUBWAY_PORT, then the project's running daemon, then 8089", () => {
  const root = makeTempFixturesDir();
  try {
    const sub = path.join(root, "backend");
    mkdirSync(sub, { recursive: true });
    mkdirSync(path.join(root, ".git"));

    withoutStubwayPort(() => {
      assert.equal(resolvePort({}, sub), 8089);
      writePidfile(root, 3610);
      assert.equal(resolvePort({}, sub), 3610);
      assert.equal(resolvePort({ port: "4000" }, sub), 4000);
      process.env.STUBWAY_PORT = "4100";
      assert.equal(resolvePort({}, sub), 4100);
    });
  } finally {
    removeTempDir(root);
  }
});

test("resolvePort rejects an unparseable port instead of falling back to the default", () => {
  withoutStubwayPort(() => {
    assert.throws(() => resolvePort({ port: "abc" }), /--port must be a port number/);
    process.env.STUBWAY_PORT = "70000";
    assert.throws(() => resolvePort({}), /STUBWAY_PORT/);
  });
});

test("resolveTarget carries the pidfile's pid so the client can verify the daemon it reaches", () => {
  const root = makeTempFixturesDir();
  try {
    mkdirSync(path.join(root, ".git"));
    withoutStubwayPort(() => {
      writePidfile(root, 3610);
      assert.deepEqual(resolveTarget({}, root), { port: 3610, pid: 1 });
      assert.deepEqual(resolveTarget({ port: "4000" }, root), { port: 4000 });
    });
  } finally {
    removeTempDir(root);
  }
});

test("STUBWAY_PORT counts as an explicit port, which is what guards stop", () => {
  withoutStubwayPort(() => {
    assert.equal(explicitPort({}), undefined);
    process.env.STUBWAY_PORT = "3611";
    assert.equal(explicitPort({}), 3611);
  });
});
