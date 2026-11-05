import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CONTROL_PREFIX } from "./constants.js";
import { handleControl } from "./control.js";
import { flattenHeaders, readBody, sendJson, sleep, type ParsedBody } from "./http.js";
import { recordFixture } from "./scaffold.js";
import { normalizePath, type StubwayState } from "./state.js";
import type { FixtureMethod, Route } from "./types.js";

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
  if (req.method === "OPTIONS" && !state.matchRoute(url.pathname)) {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === CONTROL_PREFIX || url.pathname.startsWith(CONTROL_PREFIX + "/")) {
    return handleControl(state, req, res, url);
  }

  return handleMock(state, req, res, url);
}

async function handleMock(
  state: StubwayState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const started = Date.now();
  const method = (req.method ?? "GET") as FixtureMethod;
  const pathname = normalizePath(url.pathname);
  const requestHeaders = flattenHeaders(req.headers);
  const body = await readBody(req);

  const match = state.matchRoute(pathname);
  const route = match?.route;
  const params = match?.params ?? {};
  if (route) {
    const fixture = state.resolveFixture(route, method);
    if (fixture) {
      if (fixture.timeoutMs) await sleep(fixture.timeoutMs);
      const responseBody = writeFixtureResponse(res, fixture);
      state.record({
        method,
        path: pathname,
        query: url.search,
        matchedRoute: route.path,
        params,
        fixture: fixture.name,
        status: fixture.status,
        requestHeaders,
        requestBody: body.value,
        responseBody,
        unmatched: false,
        proxied: false,
        durationMs: Date.now() - started,
      });
      return;
    }
  }

  // No matching fixture: proxy (optionally recording) or fail loudly.
  if (state.runtime.proxy) {
    return proxyRequest(state, req, res, url, { started, requestHeaders, body, route, params });
  }

  const status = 404;
  sendJson(res, status, {
    error: "stubway: no fixture matched",
    method,
    path: pathname,
    hint: route
      ? `route "${route.path}" exists but has no fixture for ${method}`
      : `no route directory maps to "${pathname}"`,
  });
  state.record({
    method,
    path: pathname,
    query: url.search,
    matchedRoute: route?.path ?? null,
    params,
    fixture: null,
    status,
    requestHeaders,
    requestBody: body.value,
    responseBody: null,
    unmatched: true,
    proxied: false,
    durationMs: Date.now() - started,
  });
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

interface ProxyContext {
  started: number;
  requestHeaders: Record<string, string>;
  body: ParsedBody;
  route: Route | undefined;
  params: Record<string, string>;
}

async function proxyRequest(
  state: StubwayState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ProxyContext,
): Promise<void> {
  const target = state.runtime.proxy!.replace(/\/$/, "") + normalizePath(url.pathname) + url.search;
  const method = req.method ?? "GET";

  const forwardHeaders = { ...ctx.requestHeaders };
  delete forwardHeaders.host;
  delete forwardHeaders["content-length"];

  const upstream = await fetch(target, {
    method,
    headers: forwardHeaders,
    body: ctx.body.raw && method !== "GET" && method !== "HEAD" ? ctx.body.raw : undefined,
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

  if (state.runtime.record) {
    const routePath = ctx.route?.path ?? normalizePath(url.pathname);
    recordFixture(state.runtime.fixturesDir, routePath, {
      method: method as FixtureMethod,
      status: upstream.status,
      headers: { "content-type": contentType },
      body: parsed,
    });
    state.reload();
  }

  state.record({
    method,
    path: normalizePath(url.pathname),
    query: url.search,
    matchedRoute: ctx.route?.path ?? null,
    params: ctx.params,
    fixture: null,
    status: upstream.status,
    requestHeaders: ctx.requestHeaders,
    requestBody: ctx.body.value,
    responseBody: parsed,
    unmatched: false,
    proxied: true,
    durationMs: Date.now() - ctx.started,
  });
}

function applyCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "*");
}
