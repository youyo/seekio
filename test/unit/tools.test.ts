import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaults } from "../../src/config";
import { SeekioError } from "../../src/mcp/errors";
import { FAKE_JPEG, FakeVideoBackend } from "./fake-backend";
import { cropFailed, FAKE_CROP_JPEG, FakeImageCropper } from "./fake-cropper";
import { createHarness, jsonOf, textOf } from "./mcp-harness";

const TOOL_NAMES = [
  "video_create_upload",
  "video_import_url",
  "video_info",
  "video_overview",
  "video_frames",
  "video_frame",
  "video_transcript",
  "video_delete",
];
const FAKE_JPEG_BASE64 = Buffer.from(FAKE_JPEG).toString("base64");
const FAKE_CROP_BASE64 = Buffer.from(FAKE_CROP_JPEG).toString("base64");

let backend: FakeVideoBackend;
let harness: ReturnType<typeof createHarness>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  backend = new FakeVideoBackend();
  harness = createHarness(backend);
});

describe("tools/list", () => {
  it("exposes exactly the eight tools with descriptions", async () => {
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
      upload_command:
        "curl -sS --fail-with-body -X POST -F 'file=@\"<PATH>\"' 'https://upload.example/fake-1' && printf '\\n%s\\n' 'uploaded video_id=fake-1'",
      expires_at: "2026-01-01T00:15:00.000Z",
      max_duration_seconds: defaults.maxVideoDurationSeconds,
      max_upload_bytes: defaults.maxUploadBytes,
      auto_delete_after_hours: 24,
    });
    expect(backend.calls[0]).toEqual({
      op: "createUpload",
      input: { filename: "drawer.mp4", maxDurationSeconds: 300 },
    });
  });

  it("quotes the upload_url safely inside upload_command", async () => {
    backend.uploadUrlOverride = "https://upload.example/a'b";
    const result = await harness.callTool("video_create_upload", {});
    const { upload_command, upload_url } = jsonOf<{ upload_command: string; upload_url: string }>(
      result,
    );
    expect(upload_url).toBe("https://upload.example/a'b");
    expect(upload_command).toContain("'https://upload.example/a'\\''b'");
  });

  it("never logs upload_url or upload_command", async () => {
    const logSpy = vi.spyOn(console, "log");
    await harness.callTool("video_create_upload", {});
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("upload.created");
    expect(logged).not.toContain("upload.example");
    expect(logged).not.toContain("curl");
  });

  it("describes upload_command and wait_seconds in the description", async () => {
    const { tools } = await harness.listTools();
    const desc = tools.find((t) => t.name === "video_create_upload")?.description ?? "";
    expect(desc).toContain("upload_command");
    expect(desc).toContain("<PATH>");
    expect(desc).toContain("curl 7.76");
    expect(desc).toContain("backslash");
    expect(desc).toContain("wait_seconds");
    expect(desc).not.toContain("poll video_info");
    expect(desc).toContain("uploaded video_id=");
  });

  it("prints a final 'uploaded video_id=<id>' line only when curl succeeds, and quotes the id", async () => {
    const result = await harness.callTool("video_create_upload", {});
    const { upload_command } = jsonOf<{ upload_command: string }>(result);
    expect(upload_command).toContain("&& printf '\\n%s\\n' 'uploaded video_id=fake-1'");
    expect(upload_command).not.toContain("/dev/null");
    expect(upload_command).not.toMatch(/\|\|/);
  });

  it("shell-quotes a video_id that contains a single quote", async () => {
    backend.videoIdOverride = "a'b";
    const result = await harness.callTool("video_create_upload", {});
    const { upload_command } = jsonOf<{ upload_command: string }>(result);
    expect(upload_command).toContain("'uploaded video_id=a'\\''b'");
  });

  it("rejects max_duration_seconds above the server limit", async () => {
    const result = await harness.callTool("video_create_upload", { max_duration_seconds: 301 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("[INVALID_INTERVAL]");
  });
});

describe("video_import_url description", () => {
  it("uses wait_seconds instead of polling", async () => {
    const { tools } = await harness.listTools();
    const desc = tools.find((t) => t.name === "video_import_url")?.description ?? "";
    expect(desc).toContain("wait_seconds");
    expect(desc).not.toContain("poll video_info");
  });
});

describe("auto deletion notices", () => {
  it.each(["video_create_upload", "video_import_url", "video_info"])(
    "%s description states the automatic deletion window",
    async (name) => {
      const { tools } = await harness.listTools();
      const desc = tools.find((t) => t.name === name)?.description ?? "";
      expect(desc).toContain("24 hours");
      expect(desc).toContain("video_delete");
    },
  );
});

describe("video_import_url", () => {
  it("imports a URL and returns video_id and status", async () => {
    const result = await harness.callTool("video_import_url", {
      url: "https://example.com/foo.mp4",
      filename: "foo.mp4",
    });
    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toEqual({
      video_id: "fake-1",
      status: "downloading",
      auto_delete_after_hours: 24,
    });
    expect(backend.calls[0]).toEqual({
      op: "importFromUrl",
      input: { url: "https://example.com/foo.mp4", filename: "foo.mp4" },
    });
  });

  it("does not put the URL in the logs", async () => {
    const log = vi.spyOn(console, "log");
    await harness.callTool("video_import_url", {
      url: "https://example.com/foo.mp4?X-Amz-Signature=secret",
    });
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("upload.imported"))).toBe(true);
    expect(lines.join("\n")).not.toContain("secret");
    expect(lines.join("\n")).not.toContain("example.com");
  });

  it.each([["ftp://example.com/foo.mp4"], ["not a url"], ["file:///etc/passwd"], [""]])(
    "rejects invalid url %j without calling the backend",
    async (url) => {
      const result = await harness.callTool("video_import_url", { url });
      expect(result.isError).toBe(true);
      expect(backend.calls).toHaveLength(0);
    },
  );

  it("rejects an empty filename", async () => {
    const result = await harness.callTool("video_import_url", {
      url: "https://example.com/foo.mp4",
      filename: "",
    });
    expect(result.isError).toBe(true);
    expect(backend.calls).toHaveLength(0);
  });

  it("surfaces backend errors with their code", async () => {
    backend.importError = new SeekioError("INVALID_URL", "bad url");
    const result = await harness.callTool("video_import_url", {
      url: "https://example.com/foo.mp4",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("[INVALID_URL] bad url");
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

  it("adds delete_after (createdAt + retention) and omits it without a usable createdAt", async () => {
    backend.addVideo({ id: "dated", createdAt: "2026-01-01T00:00:00Z" });
    backend.addVideo({ id: "undated" });
    backend.addVideo({ id: "garbled", createdAt: "yesterday-ish" });
    const dated = jsonOf<Record<string, unknown>>(
      await harness.callTool("video_info", { video_id: "dated" }),
    );
    expect(dated.delete_after).toBe("2026-01-02T00:00:00.000Z");
    for (const id of ["undated", "garbled"]) {
      const other = jsonOf<Record<string, unknown>>(
        await harness.callTool("video_info", { video_id: id }),
      );
      expect("delete_after" in other).toBe(false);
    }
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

describe("video_info wait_seconds", () => {
  const inprogress = { id: "w", status: "inprogress", pctComplete: 40 } as const;
  const ready = { id: "w", status: "ready", duration: 5, width: 100, height: 200 } as const;

  function waitingHarness() {
    const sleeps: number[] = [];
    const fake = new FakeVideoBackend();
    const h = createHarness(fake, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    return { fake, h, sleeps };
  }

  const infoCalls = (fake: FakeVideoBackend) => fake.calls.filter((c) => c.op === "getInfo").length;

  it("returns early once the video becomes ready", async () => {
    const { fake, h, sleeps } = waitingHarness();
    fake.setInfoSequence("w", [inprogress, inprogress, ready]);
    const result = await h.callTool("video_info", { video_id: "w", wait_seconds: 25 });
    expect(jsonOf(result)).toMatchObject({ status: "ready", ready: true });
    expect(infoCalls(fake)).toBe(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("returns early when the video errors", async () => {
    const { fake, h } = waitingHarness();
    fake.setInfoSequence("w", [inprogress, { id: "w", status: "error" }]);
    const result = await h.callTool("video_info", { video_id: "w", wait_seconds: 25 });
    expect(result.isError).toBeFalsy();
    expect(jsonOf(result)).toMatchObject({ status: "error", ready: false });
    expect(infoCalls(fake)).toBe(2);
  });

  it("returns the last state when the wait expires", async () => {
    const { fake, h, sleeps } = waitingHarness();
    fake.setInfoSequence("w", [inprogress]);
    const result = await h.callTool("video_info", { video_id: "w", wait_seconds: 5 });
    expect(result.isError).toBeFalsy();
    expect(jsonOf(result)).toMatchObject({ status: "inprogress", ready: false });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(5000);
    expect(infoCalls(fake)).toBe(sleeps.length + 1);
  });

  it("calls getInfo once when wait_seconds is omitted or 0", async () => {
    const { fake, h, sleeps } = waitingHarness();
    fake.setInfoSequence("w", [inprogress, ready]);
    await h.callTool("video_info", { video_id: "w" });
    await h.callTool("video_info", { video_id: "w", wait_seconds: 0 });
    expect(infoCalls(fake)).toBe(2);
    expect(sleeps).toEqual([]);
  });

  it("keeps waiting when ready but duration is unknown, then reports ready: false", async () => {
    const { fake, h, sleeps } = waitingHarness();
    fake.setInfoSequence("w", [{ id: "w", status: "ready" }]);
    const result = await h.callTool("video_info", { video_id: "w", wait_seconds: 5 });
    expect(jsonOf(result)).toMatchObject({ status: "ready", ready: false });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(5000);
  });

  it("wait_seconds=25 that expires sleeps 2000ms x12 then 1000ms", async () => {
    const { fake, h, sleeps } = waitingHarness();
    fake.setInfoSequence("w", [inprogress]);
    await h.callTool("video_info", { video_id: "w", wait_seconds: 25 });
    expect(sleeps).toEqual([...Array(12).fill(2000), 1000]);
  });

  it("documents the schema maximum in description and input schema", async () => {
    const { tools } = await harness.listTools();
    const desc = tools.find((t) => t.name === "video_info")?.description ?? "";
    expect(desc).toContain(`up to ${defaults.infoMaxWaitSeconds}`);
    const { instructions } = await import("../../src/mcp/instructions");
    expect(instructions).toContain(`${defaults.infoMaxWaitSeconds}`);
  });

  it("rejects out-of-range or non-integer wait_seconds", async () => {
    const { fake, h } = waitingHarness();
    fake.addVideo({ id: "w" });
    for (const wait_seconds of [-1, 26, 1.5]) {
      const result = await h.callTool("video_info", { video_id: "w", wait_seconds });
      expect(result.isError).toBe(true);
    }
    expect(infoCalls(fake)).toBe(0);
  });

  it("outputs pct_complete while encoding and omits it when unknown", async () => {
    const { fake, h } = waitingHarness();
    fake.setInfoSequence("w", [inprogress]);
    const encoding = jsonOf<Record<string, unknown>>(
      await h.callTool("video_info", { video_id: "w" }),
    );
    expect(encoding.pct_complete).toBe(40);
    fake.addVideo({ id: "r" });
    const done = jsonOf<Record<string, unknown>>(await h.callTool("video_info", { video_id: "r" }));
    expect("pct_complete" in done).toBe(false);
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
      expect(textOf(failed)).toContain("video_import_url");
    }
    expect(backend.calls.filter((c) => c.op === "getFrame")).toHaveLength(0);
  });
});

describe("frame tools reject videos longer than the limit", () => {
  it("returns VIDEO_TOO_LONG advising video_delete", async () => {
    backend.addVideo({ id: "long", duration: 412.3 });
    backend.addVideo({ id: "edge", duration: defaults.maxVideoDurationSeconds });
    for (const tool of ["video_overview", "video_frames", "video_frame"]) {
      const result = await harness.callTool(tool, { video_id: "long", start: 0, end: 1, at: 0 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        "[VIDEO_TOO_LONG] Video is 412.3s long, but Seekio allows at most 300 seconds. Delete it with video_delete and use a shorter video.",
      );
    }
    backend.addVideo({ id: "over", duration: 300.04 });
    const rounded = await harness.callTool("video_overview", { video_id: "over" });
    expect(textOf(rounded)).toContain("300.1s");
    const atLimit = await harness.callTool("video_overview", { video_id: "edge" });
    expect(atLimit.isError).toBeUndefined();
    expect(backend.calls.filter((c) => c.op === "getFrame").length).toBeGreaterThan(0);
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

  it("labels frames with the timestamp the backend actually returned", async () => {
    backend.addVideo({ id: "v", duration: 10 });
    const original = backend.getFrame.bind(backend);
    backend.getFrame = async (videoId, timestamp) => {
      const frame = await original(videoId, timestamp);
      return timestamp > 9 ? { ...frame, timestamp: 9.5 } : frame;
    };
    const result = await harness.callTool("video_overview", { video_id: "v", max_frames: 3 });
    expect(result.isError).toBeUndefined();
    const texts = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text);
    expect(texts).toContain("Frame at 9.5s");
    expect(texts).not.toContain("Frame at 9.999s");
    expect(texts[0]).toContain("0s, 5s, 9.5s");
  });

  it("caps max_frames at the per-call limit with a TOO_MANY_FRAMES result", async () => {
    backend.addVideo({ id: "v", duration: 120 });
    const result = await harness.callTool("video_overview", { video_id: "v", max_frames: 16 });
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
  it("documents how the frame count is computed in the description", async () => {
    const { tools } = await harness.listTools();
    const desc = tools.find((t) => t.name === "video_frames")?.description ?? "";
    expect(desc).toContain("floor((end - start) * fps) + 1");
    expect(desc).toContain("end is included");
    expect(desc).toContain("clamped");
  });

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
      end: 1.5,
      fps: 10,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "[TOO_MANY_FRAMES] Requested 16 frames (start 0s, end 1.5s, fps 10), but Seekio allows at most 15 frames per call. The frame count is floor((end - start) * fps) + 1. With start 0 and fps 10, end can be at most 1.4s. To keep end at 1.5s, lower fps to 9.333 or less. Or narrow the range.",
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

describe("video_frame region", () => {
  const credits = { x: 0, y: 0.8, width: 1, height: 0.2 };
  let cropper: FakeImageCropper;
  let regionHarness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    cropper = new FakeImageCropper();
    regionHarness = createHarness(backend, { cropper });
    backend.addVideo({ id: "v", duration: 10 });
  });

  it("fetches the source-resolution frame, crops it and reports the region and size", async () => {
    const result = await regionHarness.callTool("video_frame", {
      video_id: "v",
      at: 3.3474,
      region: credits,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Frame at 3.347s, region x=0 y=0.8 w=1 h=0.2 (1568x176 px)",
      },
      { type: "image", data: FAKE_CROP_BASE64, mimeType: "image/jpeg" },
    ]);
    expect(backend.calls.filter((c) => c.op === "getFrame")).toEqual([
      { op: "getFrame", videoId: "v", timestamp: 3.347, fullResolution: true },
    ]);
    expect(cropper.calls).toHaveLength(1);
    expect(cropper.calls[0]?.region).toEqual(credits);
    expect(cropper.calls[0]?.maxLongEdge).toBe(defaults.regionMaxLongEdge);
    expect(defaults.regionMaxLongEdge).toBe(1568);
  });

  it("labels the crop with the timestamp the backend actually returned", async () => {
    const original = backend.getFrame.bind(backend);
    backend.getFrame = async (id, ts, options) => ({
      ...(await original(id, ts, options)),
      timestamp: 9.5,
    });
    const result = await regionHarness.callTool("video_frame", {
      video_id: "v",
      at: 9.9,
      region: credits,
    });
    expect(textOf(result)).toMatch(/^Frame at 9\.5s, region /);
  });

  it("rejects invalid regions with INVALID_REGION before fetching any frame", async () => {
    const result = await regionHarness.callTool("video_frame", {
      video_id: "v",
      at: 1,
      region: { x: 0.6, y: 0, width: 0.5, height: 0.5 },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^\[INVALID_REGION\]/);
    expect(backend.calls.some((c) => c.op === "getFrame")).toBe(false);
    expect(cropper.calls).toHaveLength(0);
  });

  it("returns REGION_UNAVAILABLE telling the agent to drop region when there is no cropper", async () => {
    const result = await createHarness(backend).callTool("video_frame", {
      video_id: "v",
      at: 1,
      region: credits,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^\[REGION_UNAVAILABLE\].*region/);
    expect(backend.calls.some((c) => c.op === "getFrame")).toBe(false);
  });

  it("surfaces cropper failures as REGION_CROP_FAILED and logs backend.error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    cropper.error = cropFailed();
    const result = await regionHarness.callTool("video_frame", {
      video_id: "v",
      at: 1,
      region: credits,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^\[REGION_CROP_FAILED\]/);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("REGION_CROP_FAILED");
  });

  it("wraps unknown cropper exceptions as REGION_CROP_FAILED", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cropper.error = new Error("boom");
    const result = await regionHarness.callTool("video_frame", {
      video_id: "v",
      at: 1,
      region: credits,
    });
    expect(textOf(result)).toMatch(/^\[REGION_CROP_FAILED\]/);
    expect(textOf(result)).not.toContain("boom");
  });

  it("logs frame.requested with region and output size but no bytes", async () => {
    const log = vi.spyOn(console, "log");
    log.mockClear();
    await regionHarness.callTool("video_frame", { video_id: "v", at: 1, region: credits });
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("frame.requested"));
    const parsed = JSON.parse(line as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({ region: true, out_width: 1568, out_height: 176 });
    expect(line).not.toContain(FAKE_CROP_BASE64);
  });

  it("mentions region in the server instructions for reading fine text", async () => {
    const { instructions } = await import("../../src/mcp/instructions");
    expect(instructions.match(/region/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("documents region in the tool description", async () => {
    const { tools } = await regionHarness.listTools();
    const description = tools.find((t) => t.name === "video_frame")?.description ?? "";
    expect(description).toContain("region");
    expect(description).toContain("top-left");
    expect(description).toContain("y: 0.8");
  });

  it("without region behaves exactly as before (no full resolution, no crop)", async () => {
    const result = await regionHarness.callTool("video_frame", { video_id: "v", at: 3.3474 });
    expect(result.content).toEqual([
      { type: "text", text: "Frame at 3.347s" },
      { type: "image", data: FAKE_JPEG_BASE64, mimeType: "image/jpeg" },
    ]);
    expect(backend.calls.filter((c) => c.op === "getFrame")).toEqual([
      { op: "getFrame", videoId: "v", timestamp: 3.347 },
    ]);
    expect(cropper.calls).toHaveLength(0);
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

describe("404 retry budget per tool", () => {
  beforeEach(() => backend.addVideo({ id: "v", duration: 10 }));

  it("video_frame allows the single-frame budget, with and without region", async () => {
    await harness.callTool("video_frame", { video_id: "v", at: 3 });
    expect(backend.frameRetryBudgets).toEqual([defaults.frameRetrySingleMax]);
    const cropHarness = createHarness(backend, { cropper: new FakeImageCropper() });
    backend.frameRetryBudgets.length = 0;
    await cropHarness.callTool("video_frame", {
      video_id: "v",
      at: 3,
      region: { x: 0, y: 0, width: 1, height: 0.5 },
    });
    expect(backend.frameRetryBudgets).toEqual([defaults.frameRetrySingleMax]);
  });

  it("only video_frame may step back to earlier times near the end", async () => {
    await harness.callTool("video_frame", { video_id: "v", at: 3 });
    expect(backend.frameRetryEarlier).toEqual([undefined]);
    backend.frameRetryEarlier.length = 0;
    await harness.callTool("video_frames", { video_id: "v", start: 0, end: 2, fps: 1 });
    await harness.callTool("video_overview", { video_id: "v", max_frames: 3 });
    expect(backend.frameRetryEarlier).toEqual([false, false, false, false, false, false]);
  });

  it("video_frames and video_overview allow the multi-frame budget per frame", async () => {
    await harness.callTool("video_frames", { video_id: "v", start: 0, end: 2, fps: 1 });
    expect(backend.frameRetryBudgets).toEqual([1, 1, 1].map(() => defaults.frameRetryMultiMax));
    backend.frameRetryBudgets.length = 0;
    await harness.callTool("video_overview", { video_id: "v", max_frames: 4 });
    expect(backend.frameRetryBudgets).toEqual([1, 1, 1, 1].map(() => defaults.frameRetryMultiMax));
  });
});

describe("video_info readiness wording", () => {
  it("explains ready versus pct_complete", async () => {
    const { tools } = await harness.listTools();
    const desc = tools.find((t) => t.name === "video_info")?.description ?? "";
    expect(desc).toMatch(/ready/);
    expect(desc).toMatch(/pct_complete.*(below|less than|under) 100|100.*pct_complete/i);
  });
});
