# stubway

A file-seeded, in-memory, **agent-navigable** fake for external HTTP dependencies.

Point your app's upstream base URLs at a running stubway daemon and it answers from
JSON fixtures on disk — deterministically, with per-route control over *which* response
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
- **The captured value is recorded, not templated.** The same fixture answers for every
  value; the concrete value shows up in the request log under `params` (e.g.
  `{ "id": "42" }`), so you can assert *which* id the app requested. Fixture bodies are not
  interpolated — if a test needs a value-specific response, add another fixture or edit the
  body.
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

- `method` (default `ANY`) — a route can hold fixtures for different verbs.
- `status` — required.
- `description` — shown next to the file name in every listing, so you pick by intent.
- `timeoutMs` — delay before responding (model slow upstreams / client timeouts).
- `body` — objects/arrays sent as JSON, strings sent verbatim, omitted = empty body.

### Disk is the source of truth

The fixture catalog is re-read from disk on every request, so adding or editing a fixture
file takes effect immediately — no restart, no reload command. The **request log** and the
**active-fixture selections** are the only in-memory state.

Nothing touches disk unless you pass **`--persist`**, which on exit writes (into
`.stubway/.local/`):

- `config.json` — run config + selections (points at fixture files, doesn't inline them).
- `requests/` — one navigable JSON file per captured request.

On the next `start`, `config.json` is loaded as defaults (CLI flags still override).

### Control plane shares the port

The daemon serves mock traffic on `--port` and its control API under
`/__stubway/*` on the same port. The inspect/mutate subcommands (`routes`, `show`, `use`,
`log`, `new`) are thin clients that talk to that API, so a running daemon is required for
them. `start`/`stop`/`status` track the daemon via a pidfile in `.stubway/.local/`.

### Unmatched requests

Default: `404` with a helpful JSON body, logged as a `MISS`. With `--proxy <baseUrl>`,
unmatched requests are forwarded to the real upstream; add `--record` to save the real
response back into the fixture tree.

## Command reference

```bash
stubway start [--port 8089] [--fixtures ./fixtures] [--proxy URL] [--record] [--persist] [--foreground]
stubway status [--json]                  # is a daemon running here?
stubway stop [--json]                    # stop the daemon in this directory

stubway routes [--json]                  # list routes + active fixtures
stubway show <route> [--json]            # one route's fixtures, marking active
stubway use <route> <fixture> [--json]   # flip the active fixture (live, no restart)

stubway log [--route R] [--since ISO] [--json]   # lean list: no request/response bodies
stubway log show <id> [--json]                   # one entry's full detail (headers + bodies)
stubway log clear

stubway new fixture <route> <name> [--method POST] [--status 201] \
    [--description "..."] [--timeout-ms 3000] [--body '{"ok":true}'] [--fixtures <dir>]
# Writes to disk — no running daemon required. A route is created implicitly by its first
# fixture. Status defaults to 201 for POST, else 200. If a daemon is running, the file
# targets its fixtures dir and is served immediately.

stubway                                  # no args → interactive menu
```

All client commands accept `-p, --port` (or `STUBWAY_PORT`); default `8089`.

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
its full headers and bodies only when you actually need them.

## Development

```bash
npm install
npm run typecheck   # tsc over src/ and test/
npm test            # node's built-in test runner (via tsx, no extra deps) over test/
npm run build
```

Tests spin up the real `StubwayState` and HTTP server against a temp fixtures directory —
no mocking of stubway's own internals — and cover route matching/precedence, fixture
selection defaults, and the control API (`routes`, `use`, `log`, `log/:id`, `log/clear`).
