import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/portal";
import { SEEKIO_TOOLS } from "../../scripts/portal-lib";

const env = {
  CLOUDFLARE_ACCOUNT_ID: "acc",
  CLOUDFLARE_API_TOKEN: "tok",
  SEEKIO_MCP_URL: "https://seekio.example.workers.dev/mcp",
  SEEKIO_PORTAL_ID: "portal-1",
};

const SERVER_PATH = "/access/ai-controls/mcp/servers/seekio";
const PORTAL_PATH = "/access/ai-controls/mcp/portals/portal-1";
const allTools = () => SEEKIO_TOOLS.map((name) => ({ name }));
const allEnabled = () => SEEKIO_TOOLS.map((name) => ({ name, enabled: true }));

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];

function respond(result: unknown): Response {
  return Response.json({ success: true, result });
}

function notFound(): Response {
  return Response.json(
    { success: false, errors: [{ code: 10000, message: "not found" }] },
    { status: 404 },
  );
}

function existing(overrides: Record<string, unknown> = {}) {
  return {
    id: "seekio",
    name: "Seekio",
    hostname: env.SEEKIO_MCP_URL,
    auth_type: "unauthenticated",
    tools: [],
    ...overrides,
  };
}

function alignedPortal() {
  return {
    id: "portal-1",
    name: "Eng",
    hostname: "mcp.example.com",
    servers: [{ server_id: "seekio", updated_tools: allEnabled() }],
  };
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
      if (method === "GET" && path === SERVER_PATH) return notFound();
      if (method === "POST" && path === "/access/ai-controls/mcp/servers")
        return respond(existing());
      if (method === "POST" && path === `${SERVER_PATH}/sync`)
        return respond(existing({ status: "ready", tools: allTools() }));
      if (method === "GET" && path === PORTAL_PATH)
        return respond({ ...alignedPortal(), servers: [] });
      if (method === "PUT" && path === PORTAL_PATH) return respond({});
      throw new Error(`unexpected ${method} ${path}`);
    });
    expect(await main([], env)).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${SERVER_PATH}`,
      "POST /access/ai-controls/mcp/servers",
      `POST ${SERVER_PATH}/sync`,
      `GET ${PORTAL_PATH}`,
      `PUT ${PORTAL_PATH}`,
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
      servers: [{ server_id: "seekio", updated_tools: allEnabled() }],
    });
  });

  it("never writes in dry-run and is a no-op once aligned", async () => {
    stubApi(({ method, path }) => {
      if (method !== "GET") throw new Error(`unexpected write ${method} ${path}`);
      if (path === SERVER_PATH) return respond(existing({ tools: allTools() }));
      return respond(alignedPortal());
    });
    expect(await main(["--dry-run"], env)).toBe(0);
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    calls = [];
    stubApi(({ method, path }) => {
      if (method === "GET" && path === SERVER_PATH) return respond(existing());
      if (method === "POST" && path === `${SERVER_PATH}/sync`)
        return respond(existing({ status: "ready", tools: allTools() }));
      if (method === "GET" && path === PORTAL_PATH) return respond(alignedPortal());
      throw new Error(`unexpected write ${method} ${path}`);
    });
    expect(await main([], env)).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("always re-sends a supplied bearer token so rotations reach the portal", async () => {
    stubApi(({ method, path }) => {
      if (method === "GET" && path === SERVER_PATH)
        return respond(existing({ auth_type: "bearer" }));
      if (method === "PUT" && path === SERVER_PATH)
        return respond(existing({ auth_type: "bearer" }));
      if (method === "POST" && path === `${SERVER_PATH}/sync`)
        return respond(existing({ status: "ready", tools: allTools() }));
      if (method === "GET" && path === PORTAL_PATH) return respond(alignedPortal());
      throw new Error(`unexpected ${method} ${path}`);
    });
    expect(await main([], { ...env, SEEKIO_AUTH_TOKEN: "n3w-s3cret" })).toBe(0);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({ auth_type: "bearer", auth_credentials: "n3w-s3cret" });
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain("n3w-s3cret");
  });
});
