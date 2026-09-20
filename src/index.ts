import { createMcpHandler } from "agents/mcp/server";
import { authorize } from "./auth";
import { resolveConfig } from "./config";
import type { Env } from "./env";
import { createSeekioServer, serverInfo } from "./mcp/server";
import { CloudflareStreamBackend } from "./video/cloudflare-stream";

const MCP_ROUTE = "/mcp";

function mcpHandler(env: Env) {
  const config = resolveConfig(env);
  return createMcpHandler(
    () => createSeekioServer({ backend: new CloudflareStreamBackend(env.STREAM, config), config }),
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
} satisfies ExportedHandler<Env>;
