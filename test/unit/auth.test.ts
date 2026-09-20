import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorize } from "../../src/auth";
import type { Env } from "../../src/env";

/** Unique per test so the module-level certs cache never bleeds between cases. */
let TEAM = "";
const AUD = "aud-tag-123";

function base64Url(bytes: Uint8Array | string): string {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return buffer.toString("base64url");
}

type Signer = {
  jwk: JsonWebKey & { kid: string };
  sign: (claims: Record<string, unknown>, kid?: string) => Promise<string>;
};

async function createSigner(kid = "kid-1"): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwk = { ...publicJwk, kid, alg: "RS256", use: "sig" };
  const sign = async (claims: Record<string, unknown>, headerKid = kid) => {
    const header = base64Url(JSON.stringify({ alg: "RS256", kid: headerKid, typ: "JWT" }));
    const payload = base64Url(JSON.stringify(claims));
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
  };
  return { jwk, sign };
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://seekio.example/mcp", { method: "POST", headers });
}

function env(overrides: Partial<Env> = {}): Env {
  return { STREAM: {} as StreamBinding, ...overrides };
}

const now = () => Math.floor(Date.now() / 1000);
const validClaims = () => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  exp: now() + 300,
  nbf: now() - 10,
});

let signer: Signer;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  TEAM = `team-${crypto.randomUUID()}.cloudflareaccess.com`;
  signer = await createSigner();
  fetchMock = vi.fn(async () => Response.json({ keys: [signer.jwk] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authorize without configuration", () => {
  it("lets every request through", async () => {
    expect(await authorize(request(), env())).toBeUndefined();
  });
});

describe("bearer token", () => {
  it("accepts the matching token and rejects missing or wrong ones with 401", async () => {
    const e = env({ SEEKIO_AUTH_TOKEN: "s3cret" });
    expect(await authorize(request({ authorization: "Bearer s3cret" }), e)).toBeUndefined();
    const missing = await authorize(request(), e);
    expect(missing?.status).toBe(401);
    expect(missing?.headers.get("www-authenticate")).toBe('Bearer realm="seekio"');
    expect((await authorize(request({ authorization: "Bearer nope" }), e))?.status).toBe(401);
    expect((await authorize(request({ authorization: "Bearer s3cret1" }), e))?.status).toBe(401);
    expect((await authorize(request({ authorization: "Basic s3cret" }), e))?.status).toBe(401);
  });
});

describe("Cloudflare Access JWT", () => {
  const accessEnv = () => env({ CF_ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, CF_ACCESS_AUD: AUD });

  it("accepts a valid assertion signed by a published key", async () => {
    const jwt = await signer.sign(validClaims());
    expect(
      await authorize(request({ "cf-access-jwt-assertion": jwt }), accessEnv()),
    ).toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  });

  it("rejects missing, expired, wrong-audience, wrong-issuer, and tampered tokens with 403", async () => {
    const e = accessEnv();
    expect((await authorize(request(), e))?.status).toBe(403);
    const expired = await signer.sign({ ...validClaims(), exp: now() - 1 });
    expect((await authorize(request({ "cf-access-jwt-assertion": expired }), e))?.status).toBe(403);
    const wrongAud = await signer.sign({ ...validClaims(), aud: ["other"] });
    expect((await authorize(request({ "cf-access-jwt-assertion": wrongAud }), e))?.status).toBe(
      403,
    );
    const wrongIss = await signer.sign({ ...validClaims(), iss: "https://evil.example" });
    expect((await authorize(request({ "cf-access-jwt-assertion": wrongIss }), e))?.status).toBe(
      403,
    );
    const other = await createSigner("kid-1");
    const forged = await other.sign(validClaims());
    expect((await authorize(request({ "cf-access-jwt-assertion": forged }), e))?.status).toBe(403);
    expect((await authorize(request({ "cf-access-jwt-assertion": "garbage" }), e))?.status).toBe(
      403,
    );
  });

  it("refetches certs once when the kid is unknown", async () => {
    const rotated = await createSigner("kid-2");
    fetchMock
      .mockResolvedValueOnce(Response.json({ keys: [signer.jwk] }))
      .mockResolvedValueOnce(Response.json({ keys: [signer.jwk, rotated.jwk] }));
    const jwt = await rotated.sign(validClaims());
    expect(
      await authorize(request({ "cf-access-jwt-assertion": jwt }), accessEnv()),
    ).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is skipped when only one of the two Access vars is set", async () => {
    expect(await authorize(request(), env({ CF_ACCESS_TEAM_DOMAIN: TEAM }))).toBeUndefined();
    expect(await authorize(request(), env({ CF_ACCESS_AUD: AUD }))).toBeUndefined();
  });
});

describe("both layers configured", () => {
  it("requires the bearer token and the Access assertion together", async () => {
    const e = env({ SEEKIO_AUTH_TOKEN: "s3cret", CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD });
    const jwt = await signer.sign(validClaims());
    expect((await authorize(request({ "cf-access-jwt-assertion": jwt }), e))?.status).toBe(401);
    expect((await authorize(request({ authorization: "Bearer s3cret" }), e))?.status).toBe(403);
    expect(
      await authorize(
        request({ authorization: "Bearer s3cret", "cf-access-jwt-assertion": jwt }),
        e,
      ),
    ).toBeUndefined();
  });
});
