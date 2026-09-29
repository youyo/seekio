import { createMcpHandler } from "@modelcontextprotocol/server";
import { defaults } from "../../src/config";
import { createSeekioServer } from "../../src/mcp/server";
import type { VideoBackend } from "../../src/video/backend";
import { FakeVideoBackend } from "./fake-backend";

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = { content: Content[]; isError?: boolean };

/** Drives the real MCP server over the SDK's HTTP handler without a network or a client package. */
export function createHarness<B extends VideoBackend = FakeVideoBackend>(
  backend: B = new FakeVideoBackend() as unknown as B,
) {
  const handler = createMcpHandler(() => createSeekioServer({ backend, config: { ...defaults } }));
  let nextId = 1;

  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      }),
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .at(-1)
      : text;
    const message = JSON.parse(payload ?? "{}") as { result?: T; error?: { message: string } };
    if (message.error) throw new Error(message.error.message);
    return message.result as T;
  }

  return {
    backend,
    listTools: () =>
      rpc<{ tools: Array<{ name: string; description?: string }> }>("tools/list", {}),
    callTool: (name: string, args: Record<string, unknown>) =>
      rpc<ToolResult>("tools/call", { name, arguments: args }),
  };
}

export function textOf(result: ToolResult, index = 0): string {
  const content = result.content[index];
  if (!content || content.type !== "text") throw new Error(`content[${index}] is not text`);
  return content.text;
}

export function jsonOf<T>(result: ToolResult, index = 0): T {
  return JSON.parse(textOf(result, index)) as T;
}
