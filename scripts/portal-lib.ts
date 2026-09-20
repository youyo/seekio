/**
 * Pure logic for registering Seekio in a Cloudflare MCP Server Portal.
 * No I/O here so the desired-state computation is unit-testable.
 */

export const SEEKIO_TOOLS = [
  "video_create_upload",
  "video_info",
  "video_overview",
  "video_frames",
  "video_frame",
  "video_delete",
] as const;

export type PortalEnv = {
  accountId: string;
  apiToken: string;
  mcpUrl: string;
  portalId: string;
  serverId: string;
  authToken?: string;
};

export type EnvError = { missing: string[]; invalid: string[] };

const REQUIRED = {
  CLOUDFLARE_ACCOUNT_ID: "accountId",
  CLOUDFLARE_API_TOKEN: "apiToken",
  SEEKIO_MCP_URL: "mcpUrl",
  SEEKIO_PORTAL_ID: "portalId",
} as const;

const SERVER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseEnv(raw: NodeJS.ProcessEnv): { env: PortalEnv } | { error: EnvError } {
  const missing = Object.keys(REQUIRED).filter((key) => !raw[key]);
  const invalid: string[] = [];
  const serverId = raw.SEEKIO_PORTAL_SERVER_ID || "seekio";
  if (!SERVER_ID_PATTERN.test(serverId) || serverId.length > 32) {
    invalid.push(
      "SEEKIO_PORTAL_SERVER_ID must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ and be at most 32 characters",
    );
  }
  if (raw.SEEKIO_MCP_URL && !isValidMcpUrl(raw.SEEKIO_MCP_URL)) {
    invalid.push("SEEKIO_MCP_URL must be an https URL ending in /mcp");
  }
  if (missing.length > 0 || invalid.length > 0) return { error: { missing, invalid } };
  return {
    env: {
      accountId: raw.CLOUDFLARE_ACCOUNT_ID as string,
      apiToken: raw.CLOUDFLARE_API_TOKEN as string,
      mcpUrl: raw.SEEKIO_MCP_URL as string,
      portalId: raw.SEEKIO_PORTAL_ID as string,
      serverId,
      ...(raw.SEEKIO_AUTH_TOKEN && { authToken: raw.SEEKIO_AUTH_TOKEN }),
    },
  };
}

export function isValidMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/mcp" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export type ToolOverride = { name: string; enabled?: boolean; alias?: string };

export type PortalServer = {
  id: string;
  name: string;
  hostname: string;
  auth_type: "oauth" | "bearer" | "unauthenticated";
  tools?: Array<{ name: string }>;
  status?: string;
};

export type ServerBody = {
  id: string;
  name: string;
  hostname: string;
  auth_type: "bearer" | "unauthenticated";
  auth_credentials?: string;
};

export function desiredServer(env: PortalEnv): ServerBody {
  return {
    id: env.serverId,
    name: "Seekio",
    hostname: env.mcpUrl,
    auth_type: env.authToken ? "bearer" : "unauthenticated",
    ...(env.authToken && { auth_credentials: env.authToken }),
  };
}

/** Fields that decide whether an existing server must be updated (credentials are write-only upstream). */
export type ServerDiff = Partial<
  Record<"name" | "hostname" | "auth_type", { from: string; to: string }>
>;

export function serverDiff(current: PortalServer, desired: ServerBody): ServerDiff {
  const diff: ServerDiff = {};
  for (const key of ["name", "hostname", "auth_type"] as const) {
    if (current[key] !== desired[key]) diff[key] = { from: current[key], to: desired[key] };
  }
  return diff;
}

export function missingTools(server: Pick<PortalServer, "tools">): string[] {
  const names = new Set((server.tools ?? []).map((tool) => tool.name));
  return SEEKIO_TOOLS.filter((tool) => !names.has(tool));
}

export type PortalMapping = {
  server_id: string;
  on_behalf?: boolean;
  default_disabled?: boolean;
  updated_tools?: ToolOverride[];
  updated_prompts?: ToolOverride[];
};

export type Portal = {
  id: string;
  name: string;
  hostname: string;
  code_mode?: string;
  secure_web_gateway?: boolean;
  servers?: PortalMapping[];
};

export function desiredMapping(serverId: string, current?: PortalMapping): PortalMapping {
  return {
    ...current,
    server_id: serverId,
    updated_tools: SEEKIO_TOOLS.map((name) => ({ name, enabled: true })),
  };
}

/** Returns the new servers array for the portal, or `undefined` when nothing changes. */
export function mergePortalServers(portal: Portal, serverId: string): PortalMapping[] | undefined {
  const servers = portal.servers ?? [];
  const index = servers.findIndex((mapping) => mapping.server_id === serverId);
  const current = index >= 0 ? servers[index] : undefined;
  const desired = desiredMapping(serverId, current);
  if (
    current &&
    JSON.stringify(normalizeMapping(current)) === JSON.stringify(normalizeMapping(desired))
  ) {
    return undefined;
  }
  const next = [...servers];
  if (index >= 0) next[index] = desired;
  else next.push(desired);
  return next;
}

function normalizeMapping(mapping: PortalMapping): PortalMapping {
  const tools = [...(mapping.updated_tools ?? [])]
    .map(({ name, enabled, alias }) => ({
      name,
      ...(enabled !== undefined && { enabled }),
      ...(alias && { alias }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ...mapping, updated_tools: tools };
}

export function portalUpdateBody(portal: Portal, servers: PortalMapping[]): Omit<Portal, "id"> {
  const { id: _id, ...rest } = portal;
  return { ...rest, servers };
}
