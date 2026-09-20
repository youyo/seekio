import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/portal";
import { SEEKIO_TOOLS } from "../../scripts/portal-lib";

const env = {
  CLOUDFLARE_ACCOUNT_ID: "acc",
  CLOUDFLARE_API_TOKEN: "tok",
  SEEKIO_MCP_URL: "https://seekio.example.workers.dev/mcp",
  SEEKIO_PORTAL_ID: "portal-1",
};

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];

function respond(result: unknown): Response {
  return Response.json({ success: true, result });
}

beforeEach(() => {
  calls = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubApi(handlers: (call: Call) => Response) {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace("/client/v4/accounts/acc", ""),
      ...(init?.body && { body: JSON.parse(String(init.body)) }),
    };
    calls.push(call);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
    return handlers(call);
  });
}

describe("portal script", () => {
  it("exits 1 and lists missing env without calling the API", async () => {
    stubApi(() => respond([]));
    expect(await main(["--dry-run"], {})).toBe(1);
    expect(calls).toHaveLength(0);
    expect(console.error).toHaveBeenCalledTimes(4);
  });

  it("creates the server, syncs, and adds the portal mapping on first run", async () => {
    stubApi(({ method, path }) => {
      if (method === "GET" && path === "/access/ai-controls/mcp/servers") return respond([]);
      if (method === "POST" && path === "/access/ai-controls/mcp/servers")
        return respond({
          id: "seekio",
          name: "Seekio",
          hostname: env.SEEKIO_MCP_URL,
          auth_type: "unauthenticated",
          tools: [],
        });
      if (method === "POST" && path === "/access/ai-controls/mcp/servers/seekio/sync")
        return respond({
          id: "seekio",
          status: "ready",
          tools: SEEKIO_TOOLS.map((name) => ({ name })),
        });
      if (method === "GET" && path === "/access/ai-controls/mcp/portals/portal-1")
        return respond({ id: "portal-1", name: "Eng", hostname: "mcp.example.com", servers: [] });
      if (method === "PUT" && path === "/access/ai-controls/mcp/portals/portal-1")
        return respond({});
      throw new Error(`unexpected ${method} ${path}`);
    });
    expect(await main([], env)).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /access/ai-controls/mcp/servers",
      "POST /access/ai-controls/mcp/servers",
      "POST /access/ai-controls/mcp/servers/seekio/sync",
      "GET /access/ai-controls/mcp/portals/portal-1",
      "PUT /access/ai-controls/mcp/portals/portal-1",
    ]);
    expect(calls[1]?.body).toEqual({
      id: "seekio",
      name: "Seekio",
      hostname: env.SEEKIO_MCP_URL,
      auth_type: "unauthenticated",
    });
    expect(calls[4]?.body).toEqual({
      name: "Eng",
      hostname: "mcp.example.com",
      servers: [
        {
          server_id: "seekio",
          updated_tools: SEEKIO_TOOLS.map((name) => ({ name, enabled: true })),
        },
      ],
    });
  });

  it("is a no-op on the second run and never writes in dry-run", async () => {
    const aligned = () =>
      stubApi(({ method, path }) => {
        if (method !== "GET") throw new Error(`unexpected write ${method} ${path}`);
        if (path === "/access/ai-controls/mcp/servers")
          return respond([
            {
              id: "seekio",
              name: "Seekio",
              hostname: env.SEEKIO_MCP_URL,
              auth_type: "unauthenticated",
              tools: SEEKIO_TOOLS.map((name) => ({ name })),
            },
          ]);
        return respond({
          id: "portal-1",
          name: "Eng",
          hostname: "mcp.example.com",
          servers: [
            {
              server_id: "seekio",
              updated_tools: SEEKIO_TOOLS.map((name) => ({ name, enabled: true })),
            },
          ],
        });
      });
    aligned();
    expect(await main(["--dry-run"], env)).toBe(0);
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    calls = [];
    stubApi(({ method, path }) => {
      if (method === "GET" && path === "/access/ai-controls/mcp/servers")
        return respond([
          {
            id: "seekio",
            name: "Seekio",
            hostname: env.SEEKIO_MCP_URL,
            auth_type: "unauthenticated",
            tools: [],
          },
        ]);
      if (method === "POST" && path.endsWith("/sync"))
        return respond({
          id: "seekio",
          status: "ready",
          tools: SEEKIO_TOOLS.map((name) => ({ name })),
        });
      if (method === "GET")
        return respond({
          id: "portal-1",
          name: "Eng",
          hostname: "mcp.example.com",
          servers: [
            {
              server_id: "seekio",
              updated_tools: SEEKIO_TOOLS.map((name) => ({ name, enabled: true })),
            },
          ],
        });
      throw new Error(`unexpected write ${method} ${path}`);
    });
    expect(await main([], env)).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
  });
});
