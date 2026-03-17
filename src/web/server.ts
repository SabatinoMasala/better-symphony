/**
 * Web Dashboard Server
 * Bun.serve() with API routes, SSE streaming, and static file serving.
 */

import { resolve } from "path";
import { logger } from "../logging/logger.js";
import { WebLogBuffer, createWebSink } from "./sink.js";
import type { RuntimeSnapshot } from "../orchestrator/state.js";
import type { LogSink } from "../logging/logger.js";

interface OrchestratorHandle {
  getSnapshot(): RuntimeSnapshot | null;
  forcePoll(): Promise<void>;
  stop(): Promise<void>;
}

export interface WebServerOptions {
  port: number;
  host: string;
  orchestrator: OrchestratorHandle;
}

const STATIC_DIR = resolve(import.meta.dir, "../../dist/web");

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

export function startWebServer(options: WebServerOptions) {
  const { port, host, orchestrator } = options;
  const logBuffer = new WebLogBuffer(2000);
  const webSink: LogSink = createWebSink(logBuffer);
  logger.addSink(webSink);

  const sseClients = new Set<ReadableStreamDefaultController>();

  // Push updates to all SSE clients every second
  const pushInterval = setInterval(() => {
    if (sseClients.size === 0) return;

    const snapshot = orchestrator.getSnapshot();
    const logs = logBuffer.drain();
    const payload = JSON.stringify({
      type: "update",
      snapshot,
      logs,
      timestamp: Date.now(),
    });

    const message = `data: ${payload}\n\n`;
    for (const controller of sseClients) {
      try {
        controller.enqueue(message);
      } catch {
        sseClients.delete(controller);
      }
    }
  }, 1000);

  const server = Bun.serve({
    port,
    hostname: host,

    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      // ── API Routes ────────────────────────────────────────

      if (pathname === "/api/snapshot") {
        return Response.json(orchestrator.getSnapshot());
      }

      if (pathname === "/api/events") {
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add(controller);
            // Send initial state with log backfill
            const snapshot = orchestrator.getSnapshot();
            const initial = JSON.stringify({
              type: "initial",
              snapshot,
              logs: logBuffer.getRecent(200),
              timestamp: Date.now(),
            });
            controller.enqueue(`data: ${initial}\n\n`);
          },
          cancel(controller) {
            sseClients.delete(controller);
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (pathname === "/api/force-poll" && req.method === "POST") {
        await orchestrator.forcePoll();
        return Response.json({ ok: true });
      }

      if (pathname === "/api/shutdown" && req.method === "POST") {
        // Respond first, then stop
        setTimeout(async () => {
          await orchestrator.stop();
          process.exit(0);
        }, 200);
        return Response.json({ ok: true });
      }

      if (pathname === "/api/restart" && req.method === "POST") {
        // Stop the server to release the port, then re-exec
        setTimeout(() => {
          clearInterval(pushInterval);
          server.stop();
          const args = process.argv;
          Bun.spawn(args, {
            stdio: ["inherit", "inherit", "inherit"],
            env: process.env,
          });
          setTimeout(() => process.exit(0), 500);
        }, 100);
        return Response.json({ ok: true });
      }

      // ── Static Files ──────────────────────────────────────

      const filePath = pathname === "/" ? "/index.html" : pathname;
      const fullPath = resolve(STATIC_DIR, `.${filePath}`);

      // Prevent directory traversal
      if (!fullPath.startsWith(STATIC_DIR)) {
        return new Response("Forbidden", { status: 403 });
      }

      const file = Bun.file(fullPath);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": getMimeType(fullPath) },
        });
      }

      // SPA fallback
      const indexFile = Bun.file(resolve(STATIC_DIR, "index.html"));
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  logger.info(`Web dashboard at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);

  return {
    server,
    stop() {
      clearInterval(pushInterval);
      server.stop();
      logger.removeSink(webSink);
    },
  };
}
