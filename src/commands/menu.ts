import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { ControlClient, type RouteDto } from "../client.js";
import { daemonStatus, startDetached, stopDaemon, type DaemonInfo } from "../daemon.js";
import { formatLog } from "../format.js";
import { findProjectDir } from "../paths.js";
import { createFixture, type NewFixtureInput } from "../scaffold.js";
import { HTTP_METHODS, type FixtureMethod } from "../types.js";
import { loadCatalog } from "../fixtures.js";
import { fixturesRootProblems, resolveRuntime } from "./start.js";

export async function menuCommand(opts: { port?: string }): Promise<void> {
  const cwd = process.cwd();
  p.intro(pc.bgGreen(pc.black(" stubway ")));

  for (;;) {
    const status = await daemonStatus(findProjectDir(cwd));
    const done = status.running && status.info
      ? await runningMenu(new ControlClient(status.info.port, status.info.pid), status.info)
      : await stoppedMenu(cwd, opts);
    if (done === "exit") break;
  }

  p.outro("bye");
}

type MenuResult = "continue" | "exit";

async function stoppedMenu(cwd: string, opts: { port?: string }): Promise<MenuResult> {
  p.log.warn("No daemon running in this directory.");
  const action = await p.select({
    message: "What do you want to do?",
    options: [
      { value: "start", label: "Start daemon" },
      { value: "exit", label: "Exit" },
    ],
  });
  if (p.isCancel(action) || action === "exit") return "exit";

  const defaults = resolveRuntime(opts, cwd);
  const port = await p.text({ message: "Port", initialValue: String(defaults.port) });
  if (p.isCancel(port)) return "continue";
  const fixtures = await p.text({
    message: "Fixtures directory",
    initialValue: path.relative(cwd, defaults.fixturesDir) || ".",
  });
  if (p.isCancel(fixtures)) return "continue";

  const spinner = p.spinner();
  spinner.start("Starting daemon");
  try {
    const runtime = resolveRuntime({ port: String(port), fixtures: String(fixtures) }, cwd);
    const info = await startDetached(runtime);
    spinner.stop(`Daemon running (pid ${info.pid}) on port ${info.port}`);
    for (const problem of fixturesRootProblems(runtime.fixturesDir, loadCatalog(runtime.fixturesDir))) {
      p.log.warn(problem);
    }
  } catch (err) {
    spinner.stop(pc.red((err as Error).message));
  }
  return "continue";
}

async function runningMenu(client: ControlClient, info: DaemonInfo): Promise<MenuResult> {
  const action = await p.select({
    message: `Daemon on ${pc.cyan(`:${info.port}`)} — what do you want to do?`,
    options: [
      { value: "browse", label: "Browse routes & set active fixture" },
      { value: "log", label: "View request log" },
      { value: "newFixture", label: "Create a fixture (creates the route if new)" },
      { value: "stop", label: "Stop daemon" },
      { value: "exit", label: "Exit" },
    ],
  });
  if (p.isCancel(action) || action === "exit") return "exit";

  try {
    if (action === "browse") await browse(client);
    else if (action === "log") await viewLog(client);
    else if (action === "newFixture") await newFixture(info.fixturesDir);
    else if (action === "stop") {
      await stopDaemon(findProjectDir(process.cwd()));
      p.log.success("Daemon stopped.");
      return "continue";
    }
  } catch (err) {
    p.log.error((err as Error).message);
  }
  return "continue";
}

async function browse(client: ControlClient): Promise<void> {
  const routes = await client.routes();
  if (routes.length === 0) {
    p.log.warn("No routes yet. Create one first.");
    return;
  }

  const routePath = await p.select({
    message: "Pick a route",
    options: routes.map((r) => ({ value: r.path, label: r.path, hint: summarizeActive(r) })),
  });
  if (p.isCancel(routePath)) return;

  const route = routes.find((r) => r.path === routePath)!;
  if (route.fixtures.length === 0) {
    p.log.warn(`${routePath} has no valid fixture.\n${route.problems.join("\n")}`);
    return;
  }
  const fixture = await p.select({
    message: `Set active fixture for ${routePath}`,
    options: route.fixtures.map((f) => ({
      value: f.name,
      label: `${route.active[f.method] === f.name ? pc.green("● ") : "  "}${f.name}`,
      hint: `${f.method} ${f.status}${f.description ? ` — ${f.description}` : ""}`,
    })),
  });
  if (p.isCancel(fixture)) return;

  const updated = await client.use(String(routePath), String(fixture));
  p.log.success(`${routePath} → ${pc.green(String(fixture))}  (${summarizeActive(updated)})`);
}

async function viewLog(client: ControlClient): Promise<void> {
  const { entries } = await client.log();
  p.note(formatLog(entries.slice(-25)), `Request log (${entries.length})`);
}

async function newFixture(fixturesDir: string): Promise<void> {
  const routePath = await p.text({
    message: "Route path (existing or new)",
    placeholder: "/payments-gateway/charges",
    validate: requirePath,
  });
  if (p.isCancel(routePath)) return;

  const name = await p.text({ message: "Fixture name", placeholder: "ok", validate: requireText });
  if (p.isCancel(name)) return;

  const method = await p.select({
    message: "Method",
    initialValue: "ANY",
    options: [{ value: "ANY", label: "ANY" }, ...HTTP_METHODS.map((m) => ({ value: m, label: m }))],
  });
  if (p.isCancel(method)) return;

  const status = await p.text({
    message: "Status code",
    initialValue: "200",
    validate: (v) => (Number.isInteger(Number(v)) ? undefined : "must be a number"),
  });
  if (p.isCancel(status)) return;

  const description = await p.text({ message: "Description (optional)", initialValue: "" });
  if (p.isCancel(description)) return;

  const bodyRaw = await p.text({
    message: "Body JSON (optional)",
    placeholder: '{ "ok": true }',
    initialValue: "",
  });
  if (p.isCancel(bodyRaw)) return;

  const input: NewFixtureInput = {
    route: String(routePath).trim(),
    name: String(name).trim(),
    method: String(method) as FixtureMethod,
    status: Number(status),
  };
  const desc = String(description).trim();
  if (desc) input.description = desc;
  const body = String(bodyRaw).trim();
  if (body) {
    try {
      input.body = JSON.parse(body);
    } catch {
      input.body = body;
    }
  }

  const file = createFixture(fixturesDir, input);
  p.log.success(`Created ${input.name} → ${pc.dim(file)}`);
}

function requireText(value: string): string | undefined {
  return value && value.trim() ? undefined : "required";
}

function requirePath(value: string): string | undefined {
  if (!value || !value.trim()) return "required";
  return value.startsWith("/") ? undefined : "must start with /";
}

function summarizeActive(route: RouteDto): string {
  const parts = Object.entries(route.active).map(([m, name]) => `${m}:${name}`);
  return parts.length ? parts.join(" ") : "no active fixture";
}
