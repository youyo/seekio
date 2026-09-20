/**
 * Real Cloudflare Stream scenario against a deployed (or `wrangler dev`) Seekio.
 *
 *   SEEKIO_MCP_URL=https://seekio.<account>.workers.dev/mcp \
 *   SEEKIO_FIXTURE_VIDEO=./fixtures/drawer.mp4 \
 *   SEEKIO_AUTH_TOKEN=... CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
 *   mise run test:integration
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { McpHttpClient, type ToolResult } from "./mcp-client";

const MCP_URL = process.env.SEEKIO_MCP_URL;
const FIXTURE = process.env.SEEKIO_FIXTURE_VIDEO;
const READY_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.SEEKIO_AUTH_TOKEN)
    headers.authorization = `Bearer ${process.env.SEEKIO_AUTH_TOKEN}`;
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  }
  return headers;
}

function json<T>(result: ToolResult): T {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as T;
}

function expectJpegImages(result: ToolResult, expectedCount: number): void {
  expect(result.isError).toBeUndefined();
  const images = result.content.filter((c) => c.type === "image");
  expect(images).toHaveLength(expectedCount);
  for (const image of images) {
    if (image.type !== "image") continue;
    expect(image.mimeType).toBe("image/jpeg");
    const bytes = Buffer.from(image.data, "base64");
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  }
  // Every image is preceded by its timestamp text.
  result.content.forEach((content, index) => {
    if (content.type === "image") {
      const previous = result.content[index - 1];
      expect(previous?.type === "text" && /^Frame at [\d.]+s$/.test(previous.text)).toBe(true);
    }
  });
}

const describeIf = MCP_URL && FIXTURE ? describe : describe.skip;

describeIf("Seekio against real Cloudflare Stream", () => {
  it(
    "uploads, inspects, and deletes a video end to end",
    async () => {
      const client = new McpHttpClient({ url: MCP_URL as string, headers: authHeaders() });
      const init = await client.initialize();
      expect(init.serverInfo.name).toBe("seekio");
      expect((await client.listTools()).tools).toHaveLength(6);

      const upload = json<{ video_id: string; upload_url: string }>(
        await client.callTool("video_create_upload", { filename: basename(FIXTURE as string) }),
      );
      const form = new FormData();
      form.append(
        "file",
        new Blob([await readFile(FIXTURE as string)]),
        basename(FIXTURE as string),
      );
      const uploadResponse = await fetch(upload.upload_url, { method: "POST", body: form });
      expect(uploadResponse.ok).toBe(true);

      const deadline = Date.now() + READY_TIMEOUT_MS;
      let info: { status: string; duration?: number; ready: boolean } = {
        status: "",
        ready: false,
      };
      while (Date.now() < deadline) {
        info = json(await client.callTool("video_info", { video_id: upload.video_id }));
        if (info.ready || info.status === "error") break;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      expect(info.ready).toBe(true);
      const duration = info.duration as number;

      const overview = await client.callTool("video_overview", {
        video_id: upload.video_id,
        max_frames: 4,
      });
      expectJpegImages(overview, Math.min(4, Math.max(1, Math.ceil(duration * 1000))));

      const end = Math.min(duration, 1);
      const frames = await client.callTool("video_frames", {
        video_id: upload.video_id,
        start: 0,
        end,
        fps: 2,
      });
      expectJpegImages(frames, Math.floor(end * 2) + 1);

      const frame = await client.callTool("video_frame", {
        video_id: upload.video_id,
        at: duration / 2,
      });
      expectJpegImages(frame, 1);

      const first = json<{ deleted: boolean }>(
        await client.callTool("video_delete", { video_id: upload.video_id }),
      );
      const second = json<{ deleted: boolean }>(
        await client.callTool("video_delete", { video_id: upload.video_id }),
      );
      expect(first.deleted).toBe(true);
      expect(second.deleted).toBe(true);
    },
    10 * 60 * 1000,
  );
});

if (!MCP_URL || !FIXTURE) {
  console.log(
    "integration: set SEEKIO_MCP_URL and SEEKIO_FIXTURE_VIDEO to run the real Stream scenario",
  );
}
