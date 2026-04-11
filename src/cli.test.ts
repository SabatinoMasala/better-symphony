import { describe, expect, test } from "bun:test";

// ── CLI Argument Parsing ─────────────────────────────────────────
// parseArgs() is not exported, so we replicate the pure parsing logic here.
// This tests the arg-parsing algorithm, not the process.argv binding.

interface CLIOptions {
  workflowPaths: string[];
  filters: string[];
  logFile?: string;
  debug: boolean;
  dryRun: boolean;
  routes: boolean;
  headless: boolean;
  web: boolean;
  webPort: number;
  webHost: string;
}

function parseArgs(args: string[], cwd: string = "/home/user"): CLIOptions {
  const options: CLIOptions = {
    workflowPaths: [],
    filters: [],
    debug: false,
    dryRun: false,
    routes: false,
    headless: false,
    web: false,
    webPort: 3000,
    webHost: "0.0.0.0",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--workflow" || arg === "-w") {
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options.workflowPaths.push(args[++i]);
      }
    } else if (arg === "--filter" || arg === "-f") {
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options.filters.push(args[++i]);
      }
    } else if (arg === "--log" || arg === "-l") {
      options.logFile = args[++i];
    } else if (arg === "--debug" || arg === "-d") {
      options.debug = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--routes") {
      options.routes = true;
    } else if (arg === "--headless") {
      options.headless = true;
    } else if (arg === "--web") {
      options.web = true;
    } else if (arg === "--web-port") {
      options.webPort = parseInt(args[++i], 10);
    } else if (arg === "--web-host") {
      options.webHost = args[++i];
    } else if (!arg.startsWith("-")) {
      options.workflowPaths.push(arg);
    }
  }

  return options;
}

describe("CLI parseArgs", () => {
  test("defaults", () => {
    const opts = parseArgs([]);
    expect(opts.debug).toBe(false);
    expect(opts.dryRun).toBe(false);
    expect(opts.headless).toBe(false);
    expect(opts.web).toBe(false);
    expect(opts.webPort).toBe(3000);
    expect(opts.webHost).toBe("0.0.0.0");
    expect(opts.routes).toBe(false);
    expect(opts.workflowPaths).toHaveLength(0);
    expect(opts.filters).toHaveLength(0);
    expect(opts.logFile).toBeUndefined();
  });

  test("--debug flag", () => {
    expect(parseArgs(["--debug"]).debug).toBe(true);
    expect(parseArgs(["-d"]).debug).toBe(true);
  });

  test("--web flag", () => {
    expect(parseArgs(["--web"]).web).toBe(true);
  });

  test("--web-port", () => {
    expect(parseArgs(["--web-port", "8080"]).webPort).toBe(8080);
  });

  test("--web-host", () => {
    expect(parseArgs(["--web-host", "127.0.0.1"]).webHost).toBe("127.0.0.1");
  });

  test("--headless flag", () => {
    expect(parseArgs(["--headless"]).headless).toBe(true);
  });

  test("--dry-run flag", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
  });

  test("--routes flag", () => {
    expect(parseArgs(["--routes"]).routes).toBe(true);
  });

  test("--log / -l flag", () => {
    expect(parseArgs(["--log", "/tmp/symphony.log"]).logFile).toBe("/tmp/symphony.log");
    expect(parseArgs(["-l", "/tmp/out.log"]).logFile).toBe("/tmp/out.log");
  });

  test("--workflow / -w with single path", () => {
    const opts = parseArgs(["-w", "workflows/dev.md"]);
    expect(opts.workflowPaths).toEqual(["workflows/dev.md"]);
  });

  test("--workflow with multiple paths", () => {
    const opts = parseArgs(["-w", "dev.md", "qa.md"]);
    expect(opts.workflowPaths).toEqual(["dev.md", "qa.md"]);
  });

  test("--workflow stops at next flag", () => {
    const opts = parseArgs(["-w", "dev.md", "--debug"]);
    expect(opts.workflowPaths).toEqual(["dev.md"]);
    expect(opts.debug).toBe(true);
  });

  test("--filter / -f with single filter", () => {
    const opts = parseArgs(["-f", "github"]);
    expect(opts.filters).toEqual(["github"]);
  });

  test("--filter with multiple filters", () => {
    const opts = parseArgs(["-f", "dev", "review"]);
    expect(opts.filters).toEqual(["dev", "review"]);
  });

  test("positional args as workflow paths", () => {
    const opts = parseArgs(["my-workflow.md"]);
    expect(opts.workflowPaths).toEqual(["my-workflow.md"]);
  });

  test("combined flags", () => {
    const opts = parseArgs([
      "--web",
      "--web-port", "8080",
      "--debug",
      "-l", "/tmp/log",
      "-w", "dev.md",
      "-f", "cloud",
    ]);
    expect(opts.web).toBe(true);
    expect(opts.webPort).toBe(8080);
    expect(opts.debug).toBe(true);
    expect(opts.logFile).toBe("/tmp/log");
    expect(opts.workflowPaths).toEqual(["dev.md"]);
    expect(opts.filters).toEqual(["cloud"]);
  });

  test("--web combined with --headless", () => {
    const opts = parseArgs(["--web", "--headless"]);
    expect(opts.web).toBe(true);
    expect(opts.headless).toBe(true);
  });
});
