# stubway

A file-seeded, in-memory, **agent-navigable** fake for external HTTP dependencies.

Point your app's upstream base URLs at a running stubway daemon and it answers from
fixtures on disk (JSON, or JS for [handler fixtures](#handler-fixtures)) — deterministically, with per-route control over *which* response
comes back (a success, a validation error, a 30-second timeout). Built for Playwright /
integration tests against systems with heavy third-party integrations (payment gateways,
government/identity APIs, shipping carriers, any upstream you don't control).

Two interfaces over the same operations:

- **Humans** get an interactive menu (`stubway` with no args).
- **Agents** get flat, scriptable subcommands with `--json` output. [`SKILL.md`](./SKILL.md)
  documents the CLI as an agent skill — point Claude Code (or any skill-aware agent) at it.

## Quick start

```bash
npm install
npm run build          # compiles to dist/ and marks the bin executable
npm link               # optional: puts `stubway` on your PATH

# start the daemon (detached — returns once it's ready)
stubway start --fixtures examples/fixtures --port 8089
stubway status         # ● running  pid …  http://localhost:8089
# ... run your tests ...
stubway stop
```

Run `stubway` with no arguments for an interactive menu that can start/stop the daemon,
browse routes, flip active fixtures, view the log, and scaffold new fixtures.

Then point your system under test at it:

```bash
PAYMENTS_HOST=http://localhost:8089/payments-gateway
```

A request to `${PAYMENTS_HOST}/charges` resolves to the route
`/payments-gateway/charges` and returns its active fixture.

> Dev without building: `npm run dev -- start --fixtures examples/fixtures`.

## Concepts

### Project layout — one `.stubway/` folder

Stubway keeps everything in a single `.stubway/` directory (the default fixtures root).
Fixtures are committed; ephemeral runtime state is nested under `.stubway/.local/`, which
stubway auto-adds to `.stubway/.gitignore` for you.

```
.stubway/                       # default fixtures root (committed)
  payments-gateway/
    charges/
      ok.json            # 201 happy path        (active by default)
      invalid-card.json  # 422 validation error
      timeout.json       # 504 after a 30s delay
    receipts/
      found.json
  directory-api/
    accounts/
      active.json
  .gitignore                    # auto-written: ".local/"
  .local/                       # ephemeral, gitignored
    daemon.json  daemon.log     # pidfile + detached log
    config.json  requests/      # written on --persist
```

### Filesystem-as-routing

Each directory that contains fixture files **is** a route; the path mirrors the URL. Point
`--fixtures <dir>` elsewhere if you don't want the default `.stubway/` root (e.g. this
repo's `examples/fixtures`).

### Dynamic routes (path params)

A directory named with square brackets is a **dynamic segment** that matches any value in
that position (the Next.js `[slug]` convention):

```
.stubway/
  users/
    me/
      self.json          # static: serves /users/me
    [id]/
      ok.json            # dynamic: serves /users/1, /users/abc, /users/anything
```

- **Static beats dynamic.** A request to `/users/me` is served by the literal `me/` route;
  `/users/42` falls through to `[id]/`. Precedence is decided segment by segment, left to
  right, so the most specific route always wins.
- **The captured value is logged and readable by handlers.** The same fixture answers for
  every value; the concrete value shows up in the request log under `params` (e.g.
  `{ "id": "42" }`), so you can assert *which* id the app requested, and a
  [handler fixture](#handler-fixtures) can read it as `req.params.id`.
- **Addressing accepts `:id` or `[id]`.** On disk the segment is always `[id]` (a colon is
  not a valid path character everywhere), but the CLI accepts the shell-friendlier colon
  form for every command that takes a route:

  ```bash
  stubway new fixture /users/:id ok --body '{"who":"any"}'   # writes users/[id]/ok.json
  stubway use /users/:id timeout                              # flip the dynamic route
  stubway log --route /users/:id --json                       # every call that hit /users/[id]
  ```

  `log --route /users/:id` returns *all* concrete calls served by that pattern (`/users/1`,
  `/users/2`, …), each with its captured `params`.

### Fixtures are self-contained envelopes

```json
{
  "method": "POST",
  "status": 201,
  "description": "happy path — charge captured",
  "timeoutMs": 0,
  "headers": { "x-source": "stubway" },
  "body": { "id": "ch_000123", "status": "captured" }
}
```

- `method` (default `ANY`) — a route can hold fixtures for different verbs. With nothing
  selected, a request is answered by a fixture of its own method first; `ANY` fixtures are
  the fallback.
- `status` — required, an integer from 200 to 599.
- `description` — shown next to the file name in every listing, so you pick by intent.
- `timeoutMs` — delay before responding (model slow upstreams / client timeouts), ≥ 0.
- `body` — objects/arrays sent as JSON, strings sent verbatim, omitted or `null` = empty body.

A file that breaks these rules (unknown `method` such as `PSOT`, bad `status`, invalid JSON)
is skipped, never guessed at. `show` lists it with the reason, `start` warns about it, and a
404 on its route names it.

### A selected fixture that breaks fails loudly

If the fixture you picked with `use` is later deleted (even the route's last file), made
invalid, or changed to a `method` that no longer answers the request, requests don't quietly
fall back to another fixture. They answer `500` with a
body naming the fixture and the reason, the log entry carries the same reason in `error`,
and `routes`/`show` flag the route. Automatic defaults still apply when nothing was selected.

### Handler fixtures

A `.js` file in a route directory is a fixture too. It holds the same envelope as a JSON
fixture, written as a JavaScript object literal, and may replace `body` with
`respond(req)`, a function that builds the response from the request. Use it when the
answer depends on what was sent: echoing a payload, or picking a value by a query param.

```js
// .stubway/cobrancas/ok.js
{
  method: "POST",
  status: 201,
  description: "echoes what it received, like the real gateway",
  respond: (req) => ({
    body: { id: randomInt(), valor: req.body.valor, splits: req.body.splits },
  }),
}
```

```js
// .stubway/precos/ok.js
{
  method: "GET",
  status: 200,
  respond: (req) => {
    const preco = { A: 100, B: 150 }[req.query.categoria];
    if (preco === undefined) return { status: 404, body: { erro: "categoria desconhecida" } };
    return { body: { preco } };
  },
}
```

**The file.** The whole file is one object literal. Wrapping it in parentheses and ending
with `;` are both fine. Without `respond`, a `.js` fixture is simply a static fixture in JS
syntax, with unquoted keys and comments. `method`, `status`, `description`, `timeoutMs` and
`headers` follow the [envelope rules](#fixtures-are-self-contained-envelopes) and are read
without calling `respond`, so `routes`, `show`, `use` and sequences treat handler fixtures
like any other. `show` marks them `respond(req)`. A fixture gives `body` or `respond`, never
both. `ok.json` and `ok.js` in the same directory is a name clash: `ok.js` is loaded and
`ok.json` is skipped and reported.

**`req`** is a copy of the request, so changing it doesn't change what the log recorded:

| Field | Value |
|---|---|
| `req.method` | `"POST"` |
| `req.path` | the concrete path, `/cobrancas/77` |
| `req.params` | captured dynamic segments, `{ id: "77" }` |
| `req.query` | query string as an object of strings; a repeated name keeps its last value |
| `req.headers` | request headers, lowercase names, repeated values joined with `, ` |
| `req.body` | parsed JSON when the body is JSON, the raw string otherwise, `undefined` when empty |

**The return value** is an object with any of `status`, `headers` and `body`. `status` and
`headers` replace the envelope's when given, and `body` is the response body with the same
rules as a JSON fixture's. The log's `responseBody` holds what was sent. Reading a field the
request didn't send gives `undefined`, as in any JavaScript, and a key whose value is
`undefined` is left out of the JSON. Check `stubway log show <id>` when a response looks
incomplete.

**What a handler can reach.** The file runs in its own `node:vm` context. That context holds
the JavaScript built-ins (`JSON`, `Math`, `Date`, …) and two helpers:

- `uuid()`, a fresh v4 UUID
- `randomInt()`, a fresh positive integer below 2^31

There is no `require`, `import`, `process`, `fetch`, `setTimeout` or `console`. A handler
can't call the real upstream or load the app's own code. The file is evaluated again on every
request, so nothing a handler stores survives to the next call. Ordering across calls is what
[sequences](#fixture-sequences) are for. Evaluating the file and each `respond` call stop
after one second. This keeps handlers small and pure. It is not a security boundary. A
fixture folder is code you trust, like your test files.

**Keep the logic out of the stub.** A handler echoes, looks up canned values and picks a
status. If it recomputes something the app under test also computes, such as splits from a
total, a bug in the app passes because the stub repeats it.

**Failures.** A file that doesn't evaluate to an object, or breaks the envelope rules, is
skipped and reported like an invalid JSON fixture. When `respond` throws, times out, or
returns something that isn't `{ status?, headers?, body? }` with a valid status, the request
answers `500` with a body naming the route, the fixture and the reason, including the line
(`Cannot read properties of undefined (reading 'nome') at ok.js:4:28`). The log entry
carries the same reason in `error`. A failed handler doesn't use up a
[sequence](#fixture-sequences) step.

### Fixture sequences

`use` with a comma-separated list serves the fixtures in order, one per request, then keeps
answering with the last one:

```bash
stubway use /cobrancas/:id pendente,excluida
# GET /cobrancas/1 → pendente, every later GET → excluida
stubway show /cobrancas/:id
#   sequence GET pendente → [excluida]     (brackets mark what the next request gets)
```

- Only a request served by that route and method slot advances the sequence. `routes`,
  `show` and requests in other method slots leave it where it is.
- Every name must resolve to the same method slot (the fixtures' own `method`, or `ANY`);
  a mixed list is rejected.
- `use` again, with one name or a list, replaces the sequence and resets it.
- Each log entry's `fixture` shows which step answered.
- A step that fails inside stubway (a handler throwing) stays current, so after fixing the
  file the next request gets the same step. A client that gives up still uses its step.

### Disk is the source of truth

The fixture catalog is re-read from disk on every request, so adding or editing a fixture
file takes effect immediately — no restart, no reload command. The **request log** and the
**active-fixture selections** are the only in-memory state.

Nothing touches disk unless you pass **`--persist`**, which on exit writes (into
`.stubway/.local/`):

- `config.json` — run config + selections (points at fixture files, doesn't inline them).
  A saved sequence restarts from its first fixture on the next `start`.
- `requests/` — one navigable JSON file per captured request.

On the next `start`, `config.json` is loaded as defaults (CLI flags still override).

### Control plane shares the port

The daemon serves mock traffic on `--port` and its control API under
`/__stubway/*` on the same port. The inspect/mutate subcommands (`routes`, `show`, `use`,
`log`, `new`) are thin clients that talk to that API, so a running daemon is required for
them. `start`/`stop`/`status` track the daemon via a pidfile in `.stubway/.local/`.

### Which daemon a command talks to

`-p/--port`, then `STUBWAY_PORT`, then the daemon running for this project, then `8089`.
"This project" is the nearest folder, from the current one up to the repository root, whose
`.stubway/.local/daemon.json` exists, so `routes`, `use`, `log`, `status` and `stop` run from
`backend/` find the daemon started at the repo root on any port. `start` reads `-p`, then
`STUBWAY_PORT`, then `config.json`. An unparseable port is an error, never a silent 8089.

Before each call, a command checks that the daemon runs the same stubway version, and,
when the port came from the pidfile, that it is the recorded process. A stale pidfile whose
port another stubway now uses is reported, never followed. A daemon from an older version
asks to be restarted (`stubway stop && stubway start`). `stop` doesn't recognize a 0.1.0
daemon, so kill that process by hand.

### Startup checks

`start` prints the absolute fixtures folder and its route count. It warns when the folder
doesn't exist or holds no fixtures ("Is that the correct folder? Every request will 404.")
and lists invalid fixture files. If the daemon can't start (port taken), the error is
printed directly instead of pointing at the detached log.

### Request log

Each call is logged when it arrives and completed when answered, so its `state` is:

| state | tag | meaning |
|---|---|---|
| `pending` | `WAIT` | received, response not sent yet (for example waiting out `timeoutMs`); `fixture` is already set |
| `done` | `HIT`, `MISS`, `PROXY`, `ERR` | answered; `ERR` means stubway answered with its own error, see `error` |
| `aborted` | `ABORT` | the client closed the connection before the response was sent |
| `failed` | `FAIL` | stubway itself threw while answering; see `error` |

### Unmatched requests

Default: `404` with a helpful JSON body, logged as a `MISS`. With `--proxy <baseUrl>`,
unmatched requests are forwarded to the real upstream; add `--record` to save the real
response back into the fixture tree.

## Command reference

```bash
stubway start [--port 8089] [--fixtures ./.stubway] [--proxy URL] [--record] [--persist] [--foreground]
stubway status [--json]                  # is a daemon running for this project?
stubway stop [-p PORT] [--json]          # stop this project's daemon (only if on PORT or STUBWAY_PORT)

stubway routes [--json]                  # list routes + active fixtures
stubway show <route> [--json]            # one route's fixtures, marking active
stubway use <route> <fixture> [--json]   # flip the active fixture (live, no restart)
stubway use <route> <a>,<b>[,…] [--json] # a sequence: one per request, then stays on the last

stubway log [--route R] [--method M] [--since ISO|EPOCH_MS] [--limit N] [--json] [--bodies]
                                                 # lean list; --json --bodies adds headers + bodies
stubway log show <id> [--json]                   # one entry's full detail (headers + bodies)
stubway log clear

stubway new fixture <route> <name> [--method POST] [--status 201] \
    [--description "..."] [--timeout-ms 3000] [--body '{"ok":true}'] [--fixtures <dir> | -p PORT]
# Writes to disk — no running daemon required. A route is created implicitly by its first
# fixture. Status defaults to 201 for POST, else 200. --fixtures wins; then -p/STUBWAY_PORT
# (that daemon's fixtures dir); otherwise, if this project's daemon is running, the file
# targets its fixtures dir and is served immediately. Names with
# slashes and routes resolving outside the fixtures dir are refused.

stubway                                  # no args → interactive menu
```

All client commands accept `-p, --port`; see [Which daemon a command talks to](#which-daemon-a-command-talks-to).

## Agent usage

Everything an agent needs is one daemon plus `--json`:

```bash
stubway routes --json                                   # discover surface
stubway use /payments-gateway/charges timeout           # arrange a failure
# ...drive the app under test...
stubway log --route /payments-gateway/charges --json    # assert calls happened
stubway log show <id> --json                            # full request/response for one call
```

Route paths are stable and derived from the filesystem, so an agent can map an env var
(`PAYMENTS_HOST`) to a route prefix without guessing.

`log --json` is deliberately lean — no `requestBody`/`responseBody`, just enough to confirm
which calls happened (method, path, fixture, status, duration) at a fixed, small token cost per
entry. Each entry carries a short stable `id`; drill into one with `log show <id> --json` to get
its full headers and bodies only when you actually need them, or add `--bodies` to get them
for every listed entry. `--since` takes an ISO timestamp or epoch milliseconds
(`date +%s%3N`), so back-to-back scenarios don't bleed into each other.

## Development

```bash
npm install
npm run typecheck   # tsc over src/ and test/
npm test            # node's built-in test runner (via tsx, no extra deps) over test/
npm run build
```

Tests spin up the real `StubwayState` and HTTP server against a temp fixtures directory —
no mocking of stubway's own internals — and cover route matching/precedence, fixture
selection defaults, handler fixtures, fixture sequences, and the control API (`routes`,
`use`, `log`, `log/:id`, `log/clear`).
