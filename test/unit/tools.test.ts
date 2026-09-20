import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaults } from "../../src/config";
import { FAKE_JPEG, FakeVideoBackend } from "./fake-backend";
import { createHarness, jsonOf, textOf } from "./mcp-harness";

const TOOL_NAMES = [
  "video_create_upload",
  "video_info",
  "video_overview",
  "video_frames",
  "video_frame",
  "video_delete",
];
const FAKE_JPEG_BASE64 = Buffer.from(FAKE_JPEG).toString("base64");

let backend: FakeVideoBackend;
let harness: ReturnType<typeof createHarness>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  backend = new FakeVideoBackend();
  harness = createHarness(backend);
});

describe("tools/list", () => {
  it("exposes exactly the six v1 tools with descriptions", async () => {
    const { tools } = await harness.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) expect(tool.description).toBeTruthy();
  });
});

describe("video_create_upload", () => {
  it("returns the upload contract with server limits", async () => {
    const result = await harness.callTool("video_create_upload", { filename: "drawer.mp4" });
    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toEqual({
      video_id: "fake-1",
      upload_url: "https://upload.example/fake-1",
      expires_at: "2026-01-01T00:15:00.000Z",
      max_duration_seconds: defaults.maxVideoDurationSeconds,
      max_upload_bytes: defaults.maxUploadBytes,
    });
    expect(backend.calls[0]).toEqual({
      op: "createUpload",
      input: { filename: "drawer.mp4", maxDurationSeconds: 300 },
    });
  });

  it("rejects max_duration_seconds above the server limit", async () => {
    const result = await harness.callTool("video_create_upload", { max_duration_seconds: 301 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("[INVALID_INTERVAL]");
  });
});

describe("video_info", () => {
  it("reports ready videos", async () => {
    backend.addVideo({ id: "v1", duration: 14.82 });
    const result = await harness.callTool("video_info", { video_id: "v1" });
    expect(jsonOf(result)).toEqual({
      id: "v1",
      status: "ready",
      duration: 14.82,
      width: 1179,
      height: 2556,
      ready: true,
    });
  });

  it("reports processing videos as not ready and unknown ids as errors", async () => {
    backend.addVideo({ id: "v2", status: "inprogress" });
    const processing = await harness.callTool("video_info", { video_id: "v2" });
    expect(jsonOf<{ ready: boolean; status: string }>(processing)).toMatchObject({
      ready: false,
      status: "inprogress",
    });
    const missing = await harness.callTool("video_info", { video_id: "nope" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/^\[VIDEO_NOT_FOUND\]/);
  });
});

describe("frame tools gate on readiness", () => {
  it("refuse processing and failed videos with actionable codes", async () => {
    backend.addVideo({ id: "p", status: "queued" });
    backend.addVideo({ id: "e", status: "error" });
    for (const tool of ["video_overview", "video_frames", "video_frame"]) {
      const args = { video_id: "p", start: 0, end: 1, at: 0 };
      const notReady = await harness.callTool(tool, args);
      expect(notReady.isError).toBe(true);
      expect(textOf(notReady)).toBe(
        "[VIDEO_NOT_READY] Video is still processing. Call video_info again before requesting frames.",
      );
      const failed = await harness.callTool(tool, { ...args, video_id: "e" });
      expect(textOf(failed)).toMatch(/^\[VIDEO_PROCESSING_FAILED\]/);
    }
    expect(backend.calls.filter((c) => c.op === "getFrame")).toHaveLength(0);
  });
});

describe("video_overview", () => {
  it("returns a summary followed by timestamp/image pairs in order", async () => {
    backend.addVideo({ id: "v", duration: 10 });
    const result = await harness.callTool("video_overview", { video_id: "v", max_frames: 3 });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1 + 3 * 2);
    expect(textOf(result)).toContain("3 frames");
    expect(result.content.slice(1)).toEqual([
      { type: "text", text: "Frame at 0s" },
      { type: "image", data: FAKE_JPEG_BASE64, mimeType: "image/jpeg" },
      { type: "text", text: "Frame at 5s" },
      { type: "image", data: FAKE_JPEG_BASE64, mimeType: "image/jpeg" },
      { type: "text", text: "Frame at 9.999s" },
      { type: "image", data: FAKE_JPEG_BASE64, mimeType: "image/jpeg" },
    ]);
  });

  it("caps max_frames at the per-call limit with a TOO_MANY_FRAMES result", async () => {
    backend.addVideo({ id: "v", duration: 120 });
    const result = await harness.callTool("video_overview", { video_id: "v", max_frames: 31 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^\[TOO_MANY_FRAMES\]/);
  });

  it("defaults to 12 frames", async () => {
    backend.addVideo({ id: "v", duration: 120 });
    const result = await harness.callTool("video_overview", { video_id: "v" });
    expect(result.content).toHaveLength(1 + 12 * 2);
  });
});

describe("video_frames", () => {
  it("uses the default fps and returns deterministic timestamps", async () => {
    backend.addVideo({ id: "v", duration: 10 });
    const result = await harness.callTool("video_frames", { video_id: "v", start: 3, end: 3.4 });
    expect(result.isError).toBeUndefined();
    const texts = result.content.filter((c) => c.type === "text").map((c) => c.text);
    expect(texts.slice(1)).toEqual(["Frame at 3s", "Frame at 3.2s", "Frame at 3.4s"]);
    expect(backend.calls.filter((c) => c.op === "getFrame").map((c) => c.timestamp)).toEqual([
      3, 3.2, 3.4,
    ]);
  });

  it("does not degrade fps when the frame budget is exceeded", async () => {
    backend.addVideo({ id: "v", duration: 10 });
    const result = await harness.callTool("video_frames", {
      video_id: "v",
      start: 0,
      end: 6,
      fps: 10,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "[TOO_MANY_FRAMES] Requested 61 frames, but Seekio allows at most 30 frames per call. Narrow the interval or reduce fps.",
    );
    expect(backend.calls.filter((c) => c.op === "getFrame")).toHaveLength(0);
  });

  it("reports fps above the limit with the Seekio error format", async () => {
    backend.addVideo({ id: "v", duration: 10 });
    const result = await harness.callTool("video_frames", {
      video_id: "v",
      start: 0,
      end: 0.1,
      fps: 31,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^\[INVALID_INTERVAL\] fps 31 exceeds the maximum of 30/);
  });

  it("rejects end beyond the duration", async () => {
    backend.addVideo({ id: "v", duration: 10 });
    const result = await harness.callTool("video_frames", { video_id: "v", start: 9, end: 11 });
    expect(textOf(result)).toMatch(/^\[INVALID_INTERVAL\]/);
  });
});

describe("video_frame", () => {
  it("returns one timestamped image", async () => {
    backend.addVideo({ id: "v", duration: 10 });
    const result = await harness.callTool("video_frame", { video_id: "v", at: 3.3474 });
    expect(result.content).toEqual([
      { type: "text", text: "Frame at 3.347s" },
      { type: "image", data: FAKE_JPEG_BASE64, mimeType: "image/jpeg" },
    ]);
  });

  it("rejects timestamps at or beyond the duration", async () => {
    backend.addVideo({ id: "v", duration: 10 });
    const result = await harness.callTool("video_frame", { video_id: "v", at: 10 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^\[INVALID_TIMESTAMP\]/);
  });
});

describe("video_delete", () => {
  it("deletes and stays successful on repeat", async () => {
    backend.addVideo({ id: "v" });
    const first = await harness.callTool("video_delete", { video_id: "v" });
    const second = await harness.callTool("video_delete", { video_id: "v" });
    expect(jsonOf(first)).toEqual({ video_id: "v", deleted: true });
    expect(jsonOf(second)).toEqual({ video_id: "v", deleted: true });
    expect(backend.videos.has("v")).toBe(false);
  });
});

describe("unexpected failures", () => {
  it("surface as BACKEND_ERROR results instead of protocol errors", async () => {
    backend.getInfo = async () => {
      throw new Error("boom");
    };
    const result = await harness.callTool("video_info", { video_id: "v" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("[BACKEND_ERROR] Unexpected error: boom");
  });
});
