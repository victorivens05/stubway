#!/usr/bin/env node
import { Command } from "commander";
import { startCommand, statusCommand, stopCommand } from "./commands/start.js";
import { logClearCommand, logCommand, logShowCommand, routesCommand, showCommand } from "./commands/inspect.js";
import { newFixtureCommand, useCommand } from "./commands/mutate.js";
import { menuCommand } from "./commands/menu.js";
import { version } from "./version.js";

const program = new Command();

program
  .name("stubway")
  .description("File-seeded, in-memory, agent-navigable fake for external HTTP dependencies.")
  .version(version, "-v, --version");

program
  .command("start")
  .description("Start the mock daemon (detached by default; returns once ready).")
  .option("-p, --port <port>", "port to listen on")
  .option("-f, --fixtures <dir>", "fixtures directory (default: ./fixtures)")
  .option("--proxy <baseUrl>", "forward unmatched requests to this upstream")
  .option("--record", "when proxying, save upstream responses as new fixtures")
  .option("--persist", "on exit, write config.json + requests/ to the project root")
  .option("--foreground", "run in the current terminal instead of detaching")
  .action(startCommand);

program
  .command("stop")
  .description("Stop the running daemon in this directory.")
  .option("--json", "output JSON")
  .action(stopCommand);

program
  .command("status")
  .description("Show whether a daemon is running in this directory.")
  .option("--json", "output JSON")
  .action(statusCommand);

program
  .command("routes")
  .description("List all routes and their active fixtures.")
  .option("-p, --port <port>", "daemon port")
  .option("--json", "output JSON")
  .action(routesCommand);

program
  .command("show <route>")
  .description("Show one route's fixtures and which is active.")
  .option("-p, --port <port>", "daemon port")
  .option("--json", "output JSON")
  .action(showCommand);

program
  .command("use <route> <fixture>")
  .description("Set the active fixture for a route.")
  .option("-p, --port <port>", "daemon port")
  .option("--json", "output JSON")
  .action(useCommand);

const log = program
  .command("log")
  .description("Show the captured request log.")
  .option("-p, --port <port>", "daemon port")
  .option("--route <route>", "filter by route path")
  .option("--since <iso>", "only entries at/after this ISO timestamp")
  .option("--json", "output JSON")
  .action(logCommand);

// `show`/`clear` deliberately don't redeclare -p/--json: commander mis-parses an option
// repeated on both a parent command and its subcommand, so these inherit the parent's
// via optsWithGlobals() instead.
log
  .command("show <id>")
  .description("Show one logged request's full detail, including headers and bodies.")
  .action((id, _opts, command) => logShowCommand(id, command.optsWithGlobals()));

log
  .command("clear")
  .description("Clear the request log.")
  .action((_opts, command) => logClearCommand(command.optsWithGlobals()));

const scaffold = program
  .command("new")
  .description("Scaffold fixtures (a route is created implicitly by its first fixture).");

scaffold
  .command("fixture <route> <name>")
  .description("Create a fixture file (writes to disk; no running daemon required).")
  .option("-f, --fixtures <dir>", "fixtures directory (defaults to the running daemon's, else ./fixtures)")
  .option("-m, --method <method>", "HTTP method (default: ANY)")
  .option("-s, --status <status>", "status code (default: 201 for POST, else 200)")
  .option("-d, --description <text>", "human-readable description")
  .option("--timeout-ms <ms>", "delay before responding")
  .option("--body <json>", "response body as JSON (or plain string)")
  .option("--json", "output JSON")
  .action(newFixtureCommand);

// No subcommand → interactive menu.
program.action((opts) => menuCommand(opts));

program.parseAsync(process.argv);
