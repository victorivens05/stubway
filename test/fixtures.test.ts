import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeRoutePath, loadCatalog, toRouteDir } from "../src/fixtures.js";
import { makeTempFixturesDir, removeTempDir, writeFixture } from "./helpers.js";

test("loadCatalog groups fixtures by directory into routes, sorted by path and name", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/payments-gateway/charges", "ok", { status: 201 });
    writeFixture(dir, "/payments-gateway/charges", "timeout", { status: 504 });
    writeFixture(dir, "/directory-api/accounts", "active", { status: 200 });

    const catalog = loadCatalog(dir);

    assert.deepEqual(
      catalog.map((r) => r.path),
      ["/directory-api/accounts", "/payments-gateway/charges"],
    );
    const charges = catalog.find((r) => r.path === "/payments-gateway/charges")!;
    assert.deepEqual(
      charges.fixtures.map((f) => f.name),
      ["ok", "timeout"],
    );
  } finally {
    removeTempDir(dir);
  }
});

test("loadCatalog defaults method to ANY and skips fixtures without a numeric status", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/widgets", "no-method", { status: 200 });
    writeFixture(dir, "/widgets", "broken", { description: "missing status" });

    const catalog = loadCatalog(dir);

    const widgets = catalog.find((r) => r.path === "/widgets")!;
    assert.equal(widgets.fixtures.length, 1);
    assert.equal(widgets.fixtures[0]!.method, "ANY");
  } finally {
    removeTempDir(dir);
  }
});

test("loadCatalog ignores dot-directories such as .local", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/widgets", "ok", { status: 200 });
    writeFixture(dir, "/.local/should-be-ignored", "ok", { status: 200 });

    const catalog = loadCatalog(dir);

    assert.deepEqual(
      catalog.map((r) => r.path),
      ["/widgets"],
    );
  } finally {
    removeTempDir(dir);
  }
});

test("canonicalizeRoutePath turns :id into [id], leaving other segments untouched", () => {
  assert.equal(canonicalizeRoutePath("/users/:id"), "/users/[id]");
  assert.equal(canonicalizeRoutePath("/users/[id]"), "/users/[id]");
  assert.equal(canonicalizeRoutePath("/payments-gateway/charges"), "/payments-gateway/charges");
});

test("toRouteDir maps a route path back onto disk under the fixtures root", () => {
  const dir = toRouteDir("/fx", "/users/:id");
  assert.equal(dir, "/fx/users/[id]");
});
