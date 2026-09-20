/** Minimal Streamable HTTP MCP client for integration tests (no client SDK dependency). */

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = { content: Content[]; isError?: boolean };

export type ClientOptions = {
  url: string;
  headers?: Record<string, string>;
};

export class McpHttpClient {
  private nextId = 1;

  constructor(private readonly options: ClientOptions) {}

  async initialize(): Promise<{
    serverInfo: { name: string; version: string };
    instructions?: string;
  }> {
    return this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "seekio-integration", version: "0" },
    });
  }

  listTools(): Promise<{ tools: Array<{ name: string }> }> {
    return this.rpc("tools/list", {});
  }

  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.rpc("tools/call", { name, arguments: args });
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await fetch(this.options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...this.options.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .at(-1)
      : text;
    const message = JSON.parse(payload ?? "{}") as { result?: T; error?: { message: string } };
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result as T;
  }
}
