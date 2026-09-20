/**
 * Registers or updates Seekio in a Cloudflare MCP Server Portal (idempotent).
 *
 *   mise run portal            # apply
 *   mise run portal:dry-run    # show changes only
 */
import {
  desiredServer,
  mergePortalServers,
  missingTools,
  type Portal,
  type PortalEnv,
  type PortalServer,
  parseEnv,
  portalUpdateBody,
  serverDiff,
} from "./portal-lib";

const API_BASE = "https://api.cloudflare.com/client/v4";

type ApiEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
};

async function api<T>(env: PortalEnv, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/accounts/${env.accountId}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.apiToken}`,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const envelope = (await response.json().catch(() => undefined)) as ApiEnvelope<T> | undefined;
  if (!response.ok || !envelope?.success) {
    const detail =
      envelope?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ??
      `HTTP ${response.status}`;
    throw new Error(`${method} ${path} failed: ${detail}`);
  }
  return envelope.result;
}

function print(
  step: string,
  action: "create" | "update" | "no-op" | "warn",
  detail?: unknown,
): void {
  const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  console.log(`[${step}] ${action}${suffix}`);
}

export async function main(argv: string[], rawEnv: NodeJS.ProcessEnv): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const parsed = parseEnv(rawEnv);
  if ("error" in parsed) {
    for (const key of parsed.error.missing) console.error(`missing environment variable: ${key}`);
    for (const message of parsed.error.invalid) console.error(`invalid configuration: ${message}`);
    return 1;
  }
  const env = parsed.env;
  const would = (action: "create" | "update") => (dryRun ? `would ${action}` : action);

  // 1. Server: create or update.
  const desired = desiredServer(env);
  const servers = await api<PortalServer[]>(env, "GET", "/access/ai-controls/mcp/servers");
  let server = servers.find((s) => s.id === env.serverId);
  if (!server) {
    print("server", "create", {
      id: desired.id,
      hostname: desired.hostname,
      auth_type: desired.auth_type,
    });
    if (!dryRun)
      server = await api<PortalServer>(env, "POST", "/access/ai-controls/mcp/servers", desired);
    else console.log(`[server] ${would("create")}`);
  } else {
    const diff = serverDiff(server, desired);
    if (Object.keys(diff).length > 0) {
      print("server", "update", diff);
      if (!dryRun)
        server = await api<PortalServer>(
          env,
          "PUT",
          `/access/ai-controls/mcp/servers/${env.serverId}`,
          desired,
        );
      else console.log(`[server] ${would("update")}`);
    } else {
      print("server", "no-op");
    }
  }

  // 2. Sync tools and verify the six Seekio tools are visible.
  if (server && !dryRun) {
    const synced = await api<PortalServer>(
      env,
      "POST",
      `/access/ai-controls/mcp/servers/${env.serverId}/sync`,
    );
    const missing = missingTools(synced);
    if (missing.length > 0) {
      print("sync", "warn", { status: synced.status, missing_tools: missing });
    } else {
      print("sync", "no-op", { status: synced.status, tools: (synced.tools ?? []).length });
    }
  } else if (server) {
    print("sync", "warn", { note: "dry-run: skipped sync", missing_tools: missingTools(server) });
  }

  // 3. Portal mapping: add or align tool exposure.
  const portal = await api<Portal>(env, "GET", `/access/ai-controls/mcp/portals/${env.portalId}`);
  const merged = mergePortalServers(portal, env.serverId);
  if (!merged) {
    print("portal", "no-op");
    return 0;
  }
  const existed = (portal.servers ?? []).some((m) => m.server_id === env.serverId);
  print("portal", existed ? "update" : "create", {
    before: (portal.servers ?? []).find((m) => m.server_id === env.serverId) ?? null,
    after: merged.find((m) => m.server_id === env.serverId),
  });
  if (dryRun) {
    console.log(`[portal] ${would(existed ? "update" : "create")}`);
    return 0;
  }
  await api<Portal>(
    env,
    "PUT",
    `/access/ai-controls/mcp/portals/${env.portalId}`,
    portalUpdateBody(portal, merged),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
