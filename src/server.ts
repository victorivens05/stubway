import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CONTROL_PREFIX } from "./constants.js";
import { handleControl } from "./control.js";
import { flattenHeaders, readBody, sendJson, sleep, type ParsedBody } from "./http.js";
import path from "node:path";
import { envelopeProblem } from "./fixtures.js";
import { errorMessage } from "./handler.js";
import { recordFixture } from "./scaffold.js";
import { advanceSequence, normalizePath, type FixtureResolution, type StubwayState } from "./state.js";
import type { Fixture, FixtureMethod, HandlerRequest, LogEntry, Route } from "./types.js";

export function createStubwayServer(state: StubwayState): Server {
  return createServer((req, res) => {
    void dispatch(state, req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
      else res.end();
    });
  });
}

async function dispatch(
  state: StubwayState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${state.runtime.port}`);
  // Disk is the source of truth: pick up fixture edits/additions on every request.
  state.reload();
  applyCors(res);
  const isCorsPreflight = req.method === "OPTIONS" && req.headers["access-control-request-method"] !== undefined;
  if (isCorsPreflight && !state.matchRoute(url.pathname)) {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === CONTROL_PREFIX || url.pathname.startsWith(CONTROL_PREFIX + "/")) {
    return handleControl(state, req, res, url);
  }

  return handleMock(state, req, res, url);
}

/** One mock request in flight. `entry` is already in the log, in state "pending". */
interface MockRequest {
  url: URL;
  method: FixtureMethod;
  pathname: string;
  requestHeaders: Record<string, string>;
  body: ParsedBody;
  route: Route | undefined;
  params: Record<string, string>;
  entry: LogEntry;
}

/** What was sent back, used to complete the log entry. */
interface MockOutcome {
  status: number;
  responseBody: unknown;
  error?: string;
  unmatched?: boolean;
  proxied?: boolean;
}

async function handleMock(
  state: StubwayState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const started = Date.now();
  const arrived = logArrival(state, req, url);
  markAbortOnDisconnect(res, arrived.entry, started);
  try {
    const body = await readBody(req);
    arrived.entry.requestBody = body.value;
    const mock: MockRequest = { ...arrived, body };
    const outcome = await answerMockRequest(state, req, res, mock);
    completeEntry(mock.entry, outcome, started);
  } catch (err) {
    failEntry(arrived.entry, err as Error, started);
    throw err;
  }
}

/** Log the request as pending before reading its body, so an upload cut short still leaves an entry. */
function logArrival(state: StubwayState, req: IncomingMessage, url: URL): Omit<MockRequest, "body"> {
  const method = (req.method ?? "GET") as FixtureMethod;
  const pathname = normalizePath(url.pathname);
  const requestHeaders = flattenHeaders(req.headers);
  const match = state.matchRoute(pathname);
  const params = match?.params ?? {};
  const entry = state.record({
    method,
    path: pathname,
    query: url.search,
    matchedRoute: match?.route.path ?? null,
    params,
    fixture: null,
    status: null,
    requestHeaders,
    requestBody: undefined,
    responseBody: null,
    unmatched: false,
    proxied: false,
    durationMs: 0,
    state: "pending",
    error: null,
  });
  return { url, method, pathname, requestHeaders, route: match?.route, params, entry };
}

async function answerMockRequest(
  state: StubwayState,
  req: IncomingMessage,
  res: ServerResponse,
  mock: MockRequest,
): Promise<MockOutcome> {
  const resolution: FixtureResolution = mock.route
    ? state.resolveFixture(mock.route, mock.method)
    : { kind: "noFixture" };
  if (resolution.kind === "brokenSelection") {
    mock.entry.fixture = resolution.name;
    return respondWithBrokenSelection(res, mock.route!, resolution);
  }
  if (resolution.kind === "served") {
    mock.entry.fixture = resolution.fixture.name;
    if (resolution.fixture.timeoutMs) await sleep(resolution.fixture.timeoutMs);
    const outcome = respondWithFixture(res, mock.route!, resolution.fixture, mock);
    if (resolution.sequence && !outcome.error) advanceSequence(resolution.sequence);
    return outcome;
  }
  if (state.runtime.proxy) return proxyRequest(state, req, res, mock);
  return respondUnmatched(res, mock);
}

function respondWithBrokenSelection(
  res: ServerResponse,
  route: Route,
  resolution: Extract<FixtureResolution, { kind: "brokenSelection" }>,
): MockOutcome {
  const payload = {
    error: "stubway: selected fixture can't be served",
    route: route.path,
    fixture: resolution.name,
    reason: resolution.reason,
    hint: `fix the file, or pick another fixture with: stubway use ${route.path} <fixture>`,
  };
  sendJson(res, 500, payload);
  return { status: 500, responseBody: payload, error: resolution.reason };
}

function respondWithFixture(res: ServerResponse, route: Route, fixture: Fixture, mock: MockRequest): MockOutcome {
  if (!fixture.respond) return { status: fixture.status, responseBody: writeFixtureResponse(res, fixture) };
  let response: Pick<Fixture, "status" | "headers" | "body">;
  try {
    response = callRespond(fixture, handlerRequest(mock));
  } catch (err) {
    const payload = {
      error: "stubway: handler fixture failed",
      route: route.path,
      fixture: fixture.name,
      reason: errorMessage(err),
    };
    sendJson(res, 500, payload);
    return { status: 500, responseBody: payload, error: payload.reason };
  }
  return { status: response.status, responseBody: writeFixtureResponse(res, response) };
}

/** Run a handler fixture's respond(req) and merge its answer over the envelope's status and headers. */
function callRespond(fixture: Fixture, req: HandlerRequest): Pick<Fixture, "status" | "headers" | "body"> {
  const answer = fixture.respond!(req);
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    throw new Error(`respond must return an object like { status, headers, body }, got ${JSON.stringify(answer)}`);
  }
  const { status, headers, body } = answer as Record<string, unknown>;
  const response = { status: status ?? fixture.status, headers: headers ?? fixture.headers, body };
  const problem = envelopeProblem(response);
  if (problem) throw new Error(`respond returned ${problem}`);
  return response as Pick<Fixture, "status" | "headers" | "body">;
}

/** A copy of the request for a handler, so mutating it can't change what the log recorded. */
function handlerRequest(mock: MockRequest): HandlerRequest {
  return structuredClone({
    method: mock.method,
    path: mock.pathname,
    params: mock.params,
    query: Object.fromEntries(mock.url.searchParams),
    headers: mock.requestHeaders,
    body: mock.body.value,
  });
}

function respondUnmatched(res: ServerResponse, mock: MockRequest): MockOutcome {
  const { route, method, pathname } = mock;
  const invalid = route?.invalidFixtures.map((f) => `${path.basename(f.file)} (${f.reason})`) ?? [];
  const hint = !route
    ? `no route directory maps to "${pathname}"`
    : invalid.length > 0
      ? `route "${route.path}" has no valid fixture for ${method}; invalid files: ${invalid.join("; ")}`
      : `route "${route.path}" exists but has no fixture for ${method}`;
  sendJson(res, 404, { error: "stubway: no fixture matched", method, path: pathname, hint });
  return { status: 404, responseBody: null, unmatched: true };
}

function markAbortOnDisconnect(res: ServerResponse, entry: LogEntry, started: number): void {
  res.on("close", () => {
    if (res.writableFinished || (entry.state !== "pending" && entry.state !== "done")) return;
    entry.state = "aborted";
    entry.error = "client closed the connection before the response was sent";
    entry.durationMs = Date.now() - started;
  });
}

function completeEntry(entry: LogEntry, outcome: MockOutcome, started: number): void {
  const clientGotNoBody = entry.method === "HEAD" || outcome.status === 204 || outcome.status === 304;
  entry.status = outcome.status;
  entry.responseBody = clientGotNoBody ? null : outcome.responseBody;
  entry.error = entry.error ?? outcome.error ?? null;
  entry.unmatched = outcome.unmatched ?? false;
  entry.proxied = outcome.proxied ?? false;
  if (entry.state === "pending") {
    entry.state = "done";
    entry.durationMs = Date.now() - started;
  }
}

function failEntry(entry: LogEntry, err: Error, started: number): void {
  if (entry.state === "aborted") return;
  entry.state = "failed";
  entry.status = 500;
  entry.error = err.message;
  entry.durationMs = Date.now() - started;
}

/** Serialize a fixture to the response and return the body that was sent (for logging). */
function writeFixtureResponse(res: ServerResponse, fixture: { status: number; headers?: Record<string, string>; body?: unknown }): unknown {
  const extra = fixture.headers ?? {};
  if (fixture.body === undefined || fixture.body === null) {
    res.writeHead(fixture.status, extra);
    res.end();
    return null;
  }
  if (typeof fixture.body === "string") {
    res.writeHead(fixture.status, { "content-type": "text/plain; charset=utf-8", ...extra });
    res.end(fixture.body);
    return fixture.body;
  }
  const json = JSON.stringify(fixture.body, null, 2);
  res.writeHead(fixture.status, { "content-type": "application/json; charset=utf-8", ...extra });
  res.end(json);
  return fixture.body;
}

async function proxyRequest(
  state: StubwayState,
  req: IncomingMessage,
  res: ServerResponse,
  mock: MockRequest,
): Promise<MockOutcome> {
  const target = state.runtime.proxy!.replace(/\/$/, "") + mock.pathname + mock.url.search;
  const method = req.method ?? "GET";

  const forwardHeaders = { ...mock.requestHeaders };
  delete forwardHeaders.host;
  delete forwardHeaders["content-length"];

  const upstream = await fetch(target, {
    method,
    headers: forwardHeaders,
    body: mock.body.raw && method !== "GET" && method !== "HEAD" ? mock.body.raw : undefined,
  });

  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  res.writeHead(upstream.status, { "content-type": contentType });
  res.end(text);

  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep as text */
  }

  const outcome: MockOutcome = { status: upstream.status, responseBody: parsed, proxied: true };
  if (!state.runtime.record) return outcome;
  try {
    recordFixture(state.runtime.fixturesDir, mock.route?.path ?? mock.pathname, {
      method: method as FixtureMethod,
      status: upstream.status,
      headers: { "content-type": contentType },
      body: parsed,
    });
    state.reload();
  } catch (err) {
    // The client already has the upstream response; only the recording failed.
    const error = `proxied fine, but recording the fixture failed: ${(err as Error).message}`;
    process.stderr.write(`stubway: ${error}\n`);
    return { ...outcome, error };
  }
  return outcome;
}

function applyCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "*");
}
