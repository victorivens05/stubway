/** Control API is mounted under this prefix on the same port as mock traffic. */
export const CONTROL_PREFIX = "/__stubway";

export const DEFAULT_PORT = 8089;

/** Stubway's per-project home; also the default fixtures root. Fixtures here are committed. */
export const STUBWAY_DIRNAME = ".stubway";
export const DEFAULT_FIXTURES_DIR = STUBWAY_DIRNAME;

/** Ephemeral, gitignored runtime state lives under <stubway-home>/.local. */
export const LOCAL_DIRNAME = ".local";

/** Files/dirs inside the local dir. */
export const PIDFILE = "daemon.json";
export const DAEMON_LOG = "daemon.log";
export const CONFIG_FILE = "config.json";
export const REQUESTS_DIR = "requests";
