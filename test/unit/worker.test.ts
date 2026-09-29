import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(body).toContain("deleted automatically");
  });
});

describe("worker scheduled cleanup", () => {
  const HOUR = 3_600_000;

  function streamWith(
    videos: Array<{ id: string; ageHours: number; meta?: Record<string, string> }>,
  ) {
    const deleted: string[] = [];
    const list = vi.fn(async () =>
      videos.map(
        (v) =>
          ({
            id: v.id,
            created: new Date(Date.now() - v.ageHours * HOUR).toISOString(),
            meta: v.meta ?? {},
          }) as unknown as StreamVideo,
      ),
    );
    const stream = {
      videos: { list },
      video: (id: string) => ({
        delete: async () => {
          deleted.push(id);
        },
      }),
    } as unknown as StreamBinding;
    return { stream, deleted };
  }

  const controller = { cron: "0 * * * *", scheduledTime: 0 } as unknown as ScheduledController;
  const seekio = { application: "seekio" };

  it("deletes expired Seekio videos only", async () => {
    const { stream, deleted } = streamWith([
      { id: "old", ageHours: 30, meta: seekio },
      { id: "fresh", ageHours: 1, meta: seekio },
      { id: "foreign-old", ageHours: 500, meta: { application: "other" } },
      { id: "no-meta-old", ageHours: 500 },
    ]);
    await worker.scheduled?.(controller, env({ STREAM: stream }), ctx);
    expect(deleted).toEqual(["old"]);
  });

  it("honours VIDEO_RETENTION_HOURS", async () => {
    const { stream, deleted } = streamWith([
      { id: "a", ageHours: 3, meta: seekio },
      { id: "b", ageHours: 1, meta: seekio },
    ]);
    await worker.scheduled?.(controller, env({ STREAM: stream, VIDEO_RETENTION_HOURS: "2" }), ctx);
    expect(deleted).toEqual(["a"]);
  });

  it("logs cleanup.completed with counts and duration only", async () => {
    const log = vi.spyOn(console, "log");
    const { stream } = streamWith([{ id: "secret-id-old", ageHours: 30, meta: seekio }]);
    await worker.scheduled?.(controller, env({ STREAM: stream }), ctx);
    const line = log.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("cleanup.completed"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({ event: "cleanup.completed", deleted: 1, failed: 0 });
    expect(typeof parsed.duration_ms).toBe("number");
    expect(line).not.toContain("secret-id-old");
  });
});

describe("worker region support depends on env.IMAGES", () => {
  const readyVideo = {
    id: "v",
    readyToStream: true,
    duration: 10,
    created: "2026-01-01T00:00:00Z",
    thumbnail: "https://customer-abc.cloudflarestream.com/v/thumbnails/thumbnail.jpg",
    status: { state: "ready" },
    input: { width: 1920, height: 1080 },
  };
  const stream = {
    video: () => ({
      details: async () => readyVideo,
      generateToken: async () => "TOKEN",
    }),
  } as unknown as StreamBinding;
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const images = {
    // 1st call: the source frame; 2nd call: the cropped output.
    info: vi
      .fn()
      .mockResolvedValueOnce({ format: "image/jpeg", fileSize: 4, width: 1920, height: 1080 })
      .mockResolvedValue({ format: "image/jpeg", fileSize: 4, width: 1568, height: 176 }),
    input: () => {
      const t = {
        transform: () => t,
        output: async () => ({
          contentType: () => "image/jpeg",
          image: () => new Response(JPEG).body,
        }),
      };
      return t;
    },
  } as unknown as ImagesBinding;

  async function callFrame(overrides: Partial<Env>) {
    vi.stubGlobal("fetch", async () => new Response(JPEG, { status: 200 }));
    const response = await worker.fetch(
      new Request("https://seekio.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "video_frame",
            arguments: { video_id: "v", at: 1, region: { x: 0, y: 0.8, width: 1, height: 0.2 } },
          },
        }),
      }),
      env({ STREAM: stream, ...overrides }),
      ctx,
    );
    return response.text();
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns REGION_UNAVAILABLE when IMAGES is not bound", async () => {
    const body = await callFrame({});
    expect(body).toContain("REGION_UNAVAILABLE");
  });

  it("crops through the Images binding when IMAGES is bound", async () => {
    const body = await callFrame({ IMAGES: images });
    expect(body).not.toContain("REGION_UNAVAILABLE");
    expect(body).toContain("region x=0 y=0.8 w=1 h=0.2 (1568x176 px)");
  });
});
