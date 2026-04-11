import { describe, expect, test } from "bun:test";

// ── getMimeType ──────────────────────────────────────────────────

// Replicate the MIME type logic from server.ts for unit testing
// (getMimeType is not exported, but the logic is pure)

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf("."));
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

describe("getMimeType", () => {
  test("returns text/html for .html", () => {
    expect(getMimeType("index.html")).toBe("text/html");
  });

  test("returns application/javascript for .js", () => {
    expect(getMimeType("bundle.js")).toBe("application/javascript");
  });

  test("returns text/css for .css", () => {
    expect(getMimeType("styles.css")).toBe("text/css");
  });

  test("returns application/json for .json", () => {
    expect(getMimeType("data.json")).toBe("application/json");
  });

  test("returns image/png for .png", () => {
    expect(getMimeType("logo.png")).toBe("image/png");
  });

  test("returns image/svg+xml for .svg", () => {
    expect(getMimeType("icon.svg")).toBe("image/svg+xml");
  });

  test("returns image/x-icon for .ico", () => {
    expect(getMimeType("favicon.ico")).toBe("image/x-icon");
  });

  test("returns octet-stream for unknown extensions", () => {
    expect(getMimeType("file.xyz")).toBe("application/octet-stream");
    expect(getMimeType("archive.tar.gz")).toBe("application/octet-stream");
  });

  test("handles paths with directories", () => {
    expect(getMimeType("/static/assets/app.js")).toBe("application/javascript");
    expect(getMimeType("/deep/path/to/style.css")).toBe("text/css");
  });

  test("handles dotfiles", () => {
    // .env -> ext is ".env", not in map
    expect(getMimeType(".env")).toBe("application/octet-stream");
  });
});
