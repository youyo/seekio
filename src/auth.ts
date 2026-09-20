import type { Env } from "./env";
import { log } from "./log";

const CERTS_CACHE_TTL_MS = 5 * 60 * 1000;
/** Unknown `kid`s force a refetch at most this often, so unauthenticated callers cannot hammer the certs endpoint. */
const CERTS_MIN_REFETCH_MS = 60 * 1000;

type Jwk = JsonWebKey & { kid?: string };
type CertsCacheEntry = { keys: Jwk[]; fetchedAt: number; forcedAt?: number };
const certsCache = new Map<string, CertsCacheEntry>();

function reject(status: 401 | 403, reason: string, headers: Record<string, string> = {}): Response {
  log("auth.rejected", { status, reason });
  return Response.json(
    { error: status === 401 ? "unauthorized" : "forbidden" },
    { status, headers },
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= (bytesA[i] as number) ^ (bytesB[i] as number);
  return diff === 0;
}

function checkBearer(request: Request, expected: string): Response | undefined {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token || !timingSafeEqual(token, expected)) {
    return reject(401, "bearer", { "WWW-Authenticate": 'Bearer realm="seekio"' });
  }
  return undefined;
}

function base64UrlDecode(input: string): Uint8Array {
  const base64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function normalizeTeamDomain(raw: string): string {
  return raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function fetchCerts(teamDomain: string, forceRefresh: boolean): Promise<Jwk[]> {
  const cached = certsCache.get(teamDomain);
  const now = Date.now();
  if (cached) {
    const fresh = now - cached.fetchedAt < CERTS_CACHE_TTL_MS;
    const recentlyForced =
      cached.forcedAt !== undefined && now - cached.forcedAt < CERTS_MIN_REFETCH_MS;
    if (forceRefresh ? recentlyForced : fresh) return cached.keys;
  }
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`certs endpoint returned HTTP ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  certsCache.set(teamDomain, {
    keys,
    fetchedAt: now,
    ...(forceRefresh && { forcedAt: now }),
  });
  return keys;
}

type AccessClaims = { iss?: string; aud?: string | string[]; exp?: number; nbf?: number };

async function verifyAccessJwt(jwt: string, teamDomain: string, aud: string): Promise<boolean> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  const decoder = new TextDecoder();
  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = JSON.parse(decoder.decode(base64UrlDecode(rawHeader)));
    claims = JSON.parse(decoder.decode(base64UrlDecode(rawPayload)));
  } catch {
    return false;
  }
  if (header.alg !== "RS256" || !header.kid) return false;

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (claims.iss !== `https://${teamDomain}`) return false;
  if (!audiences.includes(aud)) return false;
  if (typeof claims.exp !== "number" || claims.exp <= now) return false;
  if (typeof claims.nbf === "number" && claims.nbf > now) return false;

  let jwk = (await fetchCerts(teamDomain, false)).find((key) => key.kid === header.kid);
  if (!jwk) jwk = (await fetchCerts(teamDomain, true)).find((key) => key.kid === header.kid);
  if (!jwk) return false;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(rawSignature),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
}

async function checkAccess(
  request: Request,
  teamDomain: string,
  aud: string,
): Promise<Response | undefined> {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return reject(403, "access-missing");
  let valid = false;
  try {
    valid = await verifyAccessJwt(jwt, teamDomain, aud);
  } catch {
    valid = false;
  }
  return valid ? undefined : reject(403, "access-invalid");
}

/**
 * Enforces the configured authentication layers on `/mcp`:
 * a static bearer token (`SEEKIO_AUTH_TOKEN`) and/or a Cloudflare Access JWT
 * (`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`). Every configured layer must pass.
 * Returns a rejection response, or `undefined` when the request may proceed.
 */
export async function authorize(request: Request, env: Env): Promise<Response | undefined> {
  if (env.SEEKIO_AUTH_TOKEN) {
    const rejected = checkBearer(request, env.SEEKIO_AUTH_TOKEN);
    if (rejected) return rejected;
  }
  if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
    return checkAccess(request, normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN), env.CF_ACCESS_AUD);
  }
  return undefined;
}
