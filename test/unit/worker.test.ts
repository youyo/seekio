import { beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import type { Env } from "../../src/env";
import worker from "../../src/index";

const ctx = {} as ExecutionContext;

function env(overrides: Partial<Env> = {}): Env {
  return { STREAM: {} as StreamBinding, ...overrides };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("worker routing", () => {
  it("serves /health without authentication", async () => {
    const response = await worker.fetch(
      new Request("https://seekio.example/health"),
      env({ SEEKIO_AUTH_TOKEN: "x" }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", name: "seekio", version: pkg.version });
  });

  it("returns 404 for unknown paths", async () => {
    const response = await worker.fetch(new Request("https://seekio.example/nope"), env(), ctx);
    expect(response.status).toBe(404);
  });

  it("guards /mcp with the configured bearer token", async () => {
    const response = await worker.fetch(
      new Request("https://seekio.example/mcp", { method: "POST" }),
      env({ SEEKIO_AUTH_TOKEN: "x" }),
      ctx,
    );
    expect(response.status).toBe(401);
  });

  it("serves MCP initialize on /mcp when authorized", async () => {
    const response = await worker.fetch(
      new Request("https://seekio.example/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer x",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        }),
      }),
      env({ SEEKIO_AUTH_TOKEN: "x" }),
      ctx,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"name":"seekio"');
    expect(body).toContain("Seekio provides temporal visual I/O for videos.");
  });
});
