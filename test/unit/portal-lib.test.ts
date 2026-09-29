import { describe, expect, it } from "vitest";
import {
  desiredServer,
  isValidMcpUrl,
  mergePortalServers,
  missingTools,
  needsServerUpdate,
  type Portal,
  parseEnv,
  portalUpdateBody,
  SEEKIO_TOOLS,
  serverDiff,
} from "../../scripts/portal-lib";

const rawEnv = {
  CLOUDFLARE_ACCOUNT_ID: "acc",
  CLOUDFLARE_API_TOKEN: "tok",
  SEEKIO_MCP_URL: "https://seekio.example.workers.dev/mcp",
  SEEKIO_PORTAL_ID: "portal-1",
};

describe("parseEnv", () => {
  it("lists every missing variable at once", () => {
    const result = parseEnv({});
    expect(result).toEqual({
      error: {
        missing: [
          "CLOUDFLARE_ACCOUNT_ID",
          "CLOUDFLARE_API_TOKEN",
          "SEEKIO_MCP_URL",
          "SEEKIO_PORTAL_ID",
        ],
        invalid: [],
      },
    });
  });

  it("defaults the server id to seekio and validates URL and id shape", () => {
    expect(parseEnv(rawEnv)).toEqual({
      env: {
        accountId: "acc",
        apiToken: "tok",
        mcpUrl: rawEnv.SEEKIO_MCP_URL,
        portalId: "portal-1",
        serverId: "seekio",
      },
    });
    const bad = parseEnv({
      ...rawEnv,
      SEEKIO_MCP_URL: "http://x/mcp",
      SEEKIO_PORTAL_SERVER_ID: "Bad_Id",
    });
    expect("error" in bad && bad.error.invalid).toHaveLength(2);
  });

  it("validates SEEKIO_PORTAL_AUTH", () => {
    const bad = parseEnv({ ...rawEnv, SEEKIO_PORTAL_AUTH: "basic" });
    expect("error" in bad && bad.error.invalid.join("\n")).toContain("SEEKIO_PORTAL_AUTH");
    const noToken = parseEnv({ ...rawEnv, SEEKIO_PORTAL_AUTH: "bearer" });
    expect("error" in noToken && noToken.error.invalid.join("\n")).toContain("SEEKIO_AUTH_TOKEN");
    const ok = parseEnv({ ...rawEnv, SEEKIO_PORTAL_AUTH: "oauth" });
    expect("env" in ok && ok.env.portalAuth).toBe("oauth");
  });

  it("accepts only https URLs ending in /mcp", () => {
    expect(isValidMcpUrl("https://a.b/mcp")).toBe(true);
    expect(isValidMcpUrl("https://a.b/mcp/")).toBe(false);
    expect(isValidMcpUrl("https://a.b/sse")).toBe(false);
    expect(isValidMcpUrl("nope")).toBe(false);
  });
});

describe("desiredServer / serverDiff", () => {
  it("uses bearer auth only when SEEKIO_AUTH_TOKEN is present", () => {
    const parsed = parseEnv({ ...rawEnv, SEEKIO_AUTH_TOKEN: "s3cret" });
    if ("error" in parsed) throw new Error("unexpected");
    expect(desiredServer(parsed.env)).toEqual({
      id: "seekio",
      name: "Seekio",
      hostname: rawEnv.SEEKIO_MCP_URL,
      auth_type: "bearer",
      auth_credentials: "s3cret",
    });
    const open = parseEnv(rawEnv);
    if ("error" in open) throw new Error("unexpected");
    expect(desiredServer(open.env).auth_type).toBe("unauthenticated");
  });

  it("honours SEEKIO_PORTAL_AUTH and never sends a token for oauth", () => {
    const parsed = parseEnv({
      ...rawEnv,
      SEEKIO_PORTAL_AUTH: "oauth",
      SEEKIO_AUTH_TOKEN: "s3cret",
    });
    if ("error" in parsed) throw new Error("unexpected");
    expect(desiredServer(parsed.env)).toEqual({
      id: "seekio",
      name: "Seekio",
      hostname: rawEnv.SEEKIO_MCP_URL,
      auth_type: "oauth",
    });
    const open = parseEnv({
      ...rawEnv,
      SEEKIO_PORTAL_AUTH: "unauthenticated",
      SEEKIO_AUTH_TOKEN: "x",
    });
    if ("error" in open) throw new Error("unexpected");
    expect(desiredServer(open.env)).not.toHaveProperty("auth_credentials");
    expect(desiredServer(open.env).auth_type).toBe("unauthenticated");
  });

  it("detects auth_type drift toward oauth without forcing updates once aligned", () => {
    const parsed = parseEnv({ ...rawEnv, SEEKIO_PORTAL_AUTH: "oauth" });
    if ("error" in parsed) throw new Error("unexpected");
    const desired = desiredServer(parsed.env);
    const stale = { ...desired, auth_type: "bearer" as const };
    expect(serverDiff(stale, desired)).toEqual({ auth_type: { from: "bearer", to: "oauth" } });
    expect(needsServerUpdate(stale, desired)).toBe(true);
    expect(needsServerUpdate(desired, desired)).toBe(false);
  });

  it("reports only the fields that changed", () => {
    const parsed = parseEnv(rawEnv);
    if ("error" in parsed) throw new Error("unexpected");
    const desired = desiredServer(parsed.env);
    const current = { ...desired, tools: [] };
    expect(serverDiff(current, desired)).toEqual({});
    expect(serverDiff({ ...current, hostname: "https://old/mcp" }, desired)).toEqual({
      hostname: { from: "https://old/mcp", to: desired.hostname },
    });
  });
});

describe("missingTools", () => {
  it("names the Seekio tools the portal has not seen yet", () => {
    expect(missingTools({ tools: SEEKIO_TOOLS.map((name) => ({ name })) })).toEqual([]);
    expect(missingTools({ tools: [{ name: "video_info" }] })).toHaveLength(SEEKIO_TOOLS.length - 1);
  });
});

describe("mergePortalServers", () => {
  const portal: Portal = {
    id: "portal-1",
    name: "Eng",
    hostname: "mcp.example.com",
    servers: [{ server_id: "other", on_behalf: true }],
  };

  it("adds the mapping with all tools enabled and keeps other servers", () => {
    const merged = mergePortalServers(portal, "seekio");
    expect(merged).toHaveLength(2);
    expect(merged?.[0]).toEqual({ server_id: "other", on_behalf: true });
    expect(merged?.[1]).toEqual({
      server_id: "seekio",
      updated_tools: SEEKIO_TOOLS.map((name) => ({ name, enabled: true })),
    });
  });

  it("is a no-op when the mapping already matches, regardless of tool order", () => {
    const aligned: Portal = {
      ...portal,
      servers: [
        {
          server_id: "seekio",
          updated_tools: [...SEEKIO_TOOLS].reverse().map((name) => ({ name, enabled: true })),
        },
      ],
    };
    expect(mergePortalServers(aligned, "seekio")).toBeUndefined();
  });

  it("re-enables disabled tools while preserving other mapping fields", () => {
    const drifted: Portal = {
      ...portal,
      servers: [
        {
          server_id: "seekio",
          on_behalf: false,
          updated_tools: [{ name: "video_delete", enabled: false }],
        },
      ],
    };
    const merged = mergePortalServers(drifted, "seekio");
    expect(merged?.[0]).toEqual({
      server_id: "seekio",
      on_behalf: false,
      updated_tools: SEEKIO_TOOLS.map((name) => ({ name, enabled: true })),
    });
  });

  it("builds an update body without the id", () => {
    expect(portalUpdateBody(portal, [])).toEqual({
      name: "Eng",
      hostname: "mcp.example.com",
      servers: [],
    });
  });
});
