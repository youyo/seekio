import { createMcpHandler } from "agents/mcp/server";
import { authorize } from "./auth";
import { resolveConfig } from "./config";
import type { Env } from "./env";
import { log } from "./log";
import { isSeekioError } from "./mcp/errors";
import { createSeekioServer, serverInfo } from "./mcp/server";
import { deleteExpiredVideos } from "./video/cleanup";
import { CloudflareStreamBackend } from "./video/cloudflare-stream";
import { createImageCropper } from "./video/image";

const MCP_ROUTE = "/mcp";

function mcpHandler(env: Env) {
  const config = resolveConfig(env);
  return createMcpHandler(
    () => {
      const cropper = createImageCropper(env.IMAGES);
      return createSeekioServer({
        backend: new CloudflareStreamBackend(env.STREAM, config),
        config,
        ...(cropper && { cropper }),
      });
    },
    { route: MCP_ROUTE },
  );
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", ...serverInfo });
    }
    if (pathname === MCP_ROUTE) {
      const rejected = await authorize(request, env);
      if (rejected) return rejected;
      return mcpHandler(env)(request, env, ctx);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
  /** Cron Trigger: deletes Seekio videos older than the retention (see wrangler.jsonc `triggers`). */
  async scheduled(_controller, env, _ctx) {
    const config = resolveConfig(env);
    const backend = new CloudflareStreamBackend(env.STREAM, config);
    const started = Date.now();
    try {
      const result = await deleteExpiredVideos(backend, started, config.videoRetentionHours);
      log("cleanup.completed", { ...result, duration_ms: Date.now() - started });
    } catch (error) {
      // Only the outcome is logged: the message may carry provider details.
      log("cleanup.failed", {
        code: isSeekioError(error) ? error.code : "UNKNOWN",
        duration_ms: Date.now() - started,
      });
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
