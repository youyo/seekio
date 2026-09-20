import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({ name: "seekio", version: "0.0.0" });
  server.registerTool(
    "hello",
    { description: "smoke", inputSchema: z.object({ name: z.string().optional() }) },
    async ({ name }) => ({ content: [{ type: "text", text: `Hello, ${name ?? "World"}!` }] }),
  );
  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(createServer)(request, env, ctx);
  },
} satisfies ExportedHandler;
