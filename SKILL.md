---
name: stubway
description: Mock external HTTP dependencies (payment gateways, government/identity APIs, shipping carriers, any upstream) during Playwright/integration tests using the `stubway` CLI. Use to arrange deterministic upstream responses — success, validation errors, timeouts — flip which response a route returns, and assert what the app called. Triggers on mocking/stubbing upstreams, faking third-party APIs, or making integration tests deterministic.
---

# stubway

A daemon that answers your app's outbound HTTP calls from fixture files on disk. You
point an upstream base URL at it, then control which response each route returns.

## Model (know this, then use the commands)

- **Route = directory.** Fixtures under `<fixturesDir>/payments-gateway/charges/`
  serve the route `/payments-gateway/charges`. The fixtures root defaults to
  `./.stubway` (a project's committed home). Map an env var to a prefix:
  `PAYMENTS_HOST=http://localhost:8089/payments-gateway` → calls hit that route.
- **Dynamic segments = `[id]` directories.** A directory named `[id]` matches any value in
  that position (`users/[id]/` serves `/users/1`, `/users/anything`). Static beats dynamic
  (`users/me/` wins over `users/[id]/` for `/users/me`), decided left-to-right. The same
  fixture answers for every value; the captured value is logged under `params`
  (e.g. `{"id":"1"}`) and a handler fixture reads it as `req.params.id`. Address it with `:id` **or** `[id]` in any command
  (`stubway use /users/:id timeout`); `:id` avoids shell glob-quoting.
- **Fixture = one response,** self-contained: `{ method?, status, description?, headers?, timeoutMs?, body? }`.
  `method` defaults to `ANY`. `timeoutMs` delays the response (model slow upstreams).
  Invalid files (unknown method like `PSOT`, status outside 200–599, bad JSON or JS) are skipped
  and reported by `start`, `show`, and the 404 hint; nothing is guessed.
- **Handler fixture = a `.js` fixture whose response depends on the request.** The file is
  the same envelope as an object literal, with `respond(req)` in place of `body`:
  `{ method: "POST", status: 201, respond: (req) => ({ body: { valor: req.body.valor } }) }`.
  `req` has `method`, `path`, `params`, `query`, `headers`, `body`; the return value has
  any of `status`, `headers`, `body`. It runs in a bare `vm` context: JS built-ins plus
  `uuid()` and `randomInt()`, no `require`/`process`/`fetch`/`console`, nothing kept between
  calls. A throw answers `500` with the reason and line, also in the log's `error`. Echo
  and look up canned values; never recompute what the app under test computes.
- **One fixture is "active" per route+method.** Default when unset: the request method's own
  fixtures first, `ANY` fixtures as fallback; within each, `default` → `ok` → `success`,
  else the first alphabetically. Flip it with `use`.
- **A `use` selection never silently falls back.** If the selected fixture is deleted (even
  the route's last file), invalid, or no longer answers that method, requests answer `500` and the log entry's `error` says why;
  `routes`/`show` flag the route with `✗`.
- **`use <route> a,b` sets a sequence.** Each request served by that route and method slot
  gets the next fixture; after the end the last one keeps answering. All names must share
  one method slot. `routes`/`show` display it as `a → [b]` (brackets = next) and don't
  advance it; `use` again resets it. The log's `fixture` shows which step answered. A step
  whose handler fails stays current until it answers.
- **Disk is the source of truth.** The catalog is re-read from disk on every request, so
  files you add/edit are picked up immediately — no reload step.
- **Selections + request log are in memory.** Nothing persists unless the daemon was
  started with `--persist`.
- **The request log is lean by design.** Each captured call gets a short stable `id`.
  `stubway log` lists calls cheaply (method, path, fixture, status, duration) with no
  request/response bodies; `stubway log show <id>` fetches one call's full detail
  (headers + bodies) only when you actually need it, or add `--bodies` to a `--json` listing
  to get them for every entry. Don't guess the id — read it from a `log` listing first.
- **Each call is logged on arrival.** `state` is `pending` (tag `WAIT`, still answering, e.g.
  inside `timeoutMs`), `done`, `aborted` (client gave up) or `failed` (stubway threw).
  `error` is set when stubway answered with its own error (broken selection, handler).
- **`start` is detached** and returns once the daemon is healthy. It prints the absolute
  fixtures folder and route count, and warns when the folder is missing or empty
  ("Is that the correct folder?"). Read that warning before acting. Manage it with
  `stubway status` / `stubway stop`.
- **`new fixture` writes to disk and needs no daemon** (it targets `--fixtures` if given,
  else the daemon on `-p`/`STUBWAY_PORT`, else this project's running daemon, else
  config/`.stubway`). Everything else
  (`routes`, `show`, `use`, `log`) needs a running daemon. `use` changes runtime selection
  state, so it must go through the daemon.
- **Commands find the project's daemon.** Port: `-p`, then `STUBWAY_PORT`, then the daemon
  recorded in the nearest `.stubway/.local/daemon.json` from here up to the repo root, then
  8089. So after `stubway start -p 3610` at the repo root, `stubway routes` from `backend/`
  reaches 3610. A command refuses a daemon of another version or a stale pidfile pointing at
  someone else's daemon, and says what to run. Commands accept `--json`; always pass it when scripting, and parse
  `status --json` rather than grepping for "running" (it also matches "not running").

## Workflow

```bash
# 1. Start (detached — returns when ready). Fixtures default to ./.stubway.
stubway start --port 8089        # add --fixtures <dir> to override the default
stubway status                                           # confirm it's up

# 2. Discover the surface for the route(s) this test touches.
stubway show /payments-gateway/charges --json   # fixtures + which is active

# 3. Arrange: flip a route to the response this test needs.
stubway use /payments-gateway/charges timeout    # or ok / invalid-card / ...

# 4. Act: run the app / Playwright flow.

# 5. Assert: inspect what the app actually called.
stubway log --route /payments-gateway/charges --json   # lean list, has each call's id
stubway log show <id> --json                                    # that call's full body/headers
stubway log clear                                        # reset between tests

# 6. Tear down.
stubway stop
```

## Command cheatsheet (all take `-p <port>`, most take `--json`)

| Goal | Command |
|------|---------|
| Start (detached) | `stubway start [-p 8089] [-f <dir>]` (fixtures default `./.stubway`) |
| Check / stop daemon | `stubway status --json` · `stubway stop` |
| List routes + active fixtures | `stubway routes --json` |
| Inspect one route | `stubway show <route> --json` |
| Set active response | `stubway use <route> <fixture>` |
| Serve responses in order | `stubway use <route> pendente,excluida` |
| Read request log (lean, no bodies) | `stubway log [--route R] [--method M] [--since ISO\|EPOCH_MS] [--limit N] --json` |
| Read request log with bodies | `stubway log --json --bodies` |
| Full detail for one logged call | `stubway log show <id> --json` |
| Reset log | `stubway log clear` |
| New fixture (offline; creates route if new) | `stubway new fixture <route> <name> -m POST -d "..." --body '{"k":1}' [-s 201] [--timeout-ms 3000] [-f <dir>]` |

`log --json` entries carry `id`, `method`, `path` (concrete), `matchedRoute` (the pattern
that served it, e.g. `/users/[id]`), `params` (captured dynamic segments), `fixture`,
`status`, `unmatched`, `proxied`, `durationMs` — enough to confirm a call happened, at a
fixed small cost per entry. They do **not** include `requestBody`/`responseBody` — fetch
those for one call with `stubway log show <id> --json`.
`log --route /users/:id` returns every concrete call served by that pattern.

## Recipes

- **Echo what the app sent:** `<route>/ok.js` containing
  `{ status: 201, respond: (req) => ({ body: { id: randomInt(), splits: req.body.splits } }) }`.
- **Answer by a request value:** a lookup table in `respond`,
  `{ A: 100, B: 150 }[req.query.categoria]`, with a `404` when it's missing.
- **One flow reads the same upstream twice, before and after a change:**
  `stubway use <route> before,after`.
- **Scope the log to one scenario:** `since=$(date +%s%3N)` before acting, then
  `stubway log --since $since --json`.
- **Force an upstream failure:** `stubway use <route> <errorFixture>` before acting; a
  fixture with `timeoutMs` set simulates a hang/timeout.
- **Assert the app called an upstream with the right payload:**
  `stubway log --route <route> --json`, grab the last entry's `id`, then
  `stubway log show <id> --json` and check `requestBody`.
- **Assert an upstream was NOT called:** `stubway log --route <route> --since $since --json`
  returns no entries at all. A `MISS` is still a call the app made, so "no HIT" proves nothing.
- **Capture real responses to seed fixtures:** start with `--proxy <realBaseUrl> --record`;
  unmatched routes are forwarded and saved as `recorded-*.json` fixtures for later replay.
- **Isolate parallel workers:** run one daemon per worker, each started from its own working
  directory with its own `--port` and `--fixtures` copy. The pidfile lives in the working
  directory, so two daemons started from the same folder overwrite each other's record.

## Gotchas

- Route paths mirror the directory tree under the fixtures dir. Segments are literal unless
  bracketed: `[id]` is a dynamic wildcard. On disk it is always `[id]`, never `:id` (colon
  is not portable in paths) — the colon form is CLI addressing sugar only.
- The daemon reloads fixtures from disk per request, so a newly written file is served
  immediately — no restart. A request with no fixture of its own method falls back to
  `ANY`, else 404 (`MISS` in the log). Default status: `POST`→201, else 200.
- Unmatched request with no `--proxy` → `404` with a JSON hint, logged as `unmatched`.
- Log entry ids are short and scoped to the running daemon's in-memory log — they reset
  with `stubway log clear` or a daemon restart, so always read an id from a fresh `log`
  listing rather than reusing one across runs.
