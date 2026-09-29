import { describe, expect, it } from "vitest";
import { SeekioError } from "../../src/mcp/errors";
import type { Frame } from "../../src/video/backend";
import { fetchFramesBounded, frameTextContent, frameToImageContent } from "../../src/video/frame";
import { FAKE_JPEG, FakeVideoBackend } from "./fake-backend";

describe("fetchFramesBounded", () => {
  it("never exceeds the concurrency limit and preserves timestamp order", async () => {
    let inFlight = 0;
    let peak = 0;
    const backend = new FakeVideoBackend();
    backend.getFrame = async (_videoId, timestamp) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5 + (timestamp % 3) * 5));
      inFlight--;
      return { timestamp, mimeType: "image/jpeg", data: FAKE_JPEG.slice().buffer };
    };
    const timestamps = Array.from({ length: 20 }, (_, i) => i);
    const frames = await fetchFramesBounded(backend, "v", timestamps, 6);
    expect(frames.map((f) => f.timestamp)).toEqual(timestamps);
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
  });

  it("drops frames whose actual timestamp duplicates an earlier one (end-of-video fallback)", async () => {
    const backend = new FakeVideoBackend();
    backend.getFrame = async (_videoId, timestamp) => ({
      timestamp: timestamp > 9 ? 9 : timestamp,
      mimeType: "image/jpeg",
      data: FAKE_JPEG.slice().buffer,
    });
    const frames = await fetchFramesBounded(backend, "v", [8, 9, 9.5, 9.999], 2);
    expect(frames.map((f) => f.timestamp)).toEqual([8, 9]);
  });

  it("wraps unexpected failures as FRAME_FETCH_FAILED and keeps SeekioError codes", async () => {
    const backend = new FakeVideoBackend();
    backend.getFrame = async () => {
      throw new Error("boom");
    };
    await expect(fetchFramesBounded(backend, "v", [0, 1], 2)).rejects.toMatchObject({
      code: "FRAME_FETCH_FAILED",
    });
    backend.getFrame = async () => {
      throw new SeekioError("VIDEO_NOT_FOUND", "gone");
    };
    await expect(fetchFramesBounded(backend, "v", [0], 2)).rejects.toMatchObject({
      code: "VIDEO_NOT_FOUND",
    });
  });
});

describe("content helpers", () => {
  it("encodes JPEG bytes as base64 image content", () => {
    const frame: Frame = { timestamp: 1.5, mimeType: "image/jpeg", data: FAKE_JPEG.slice().buffer };
    const content = frameToImageContent(frame);
    expect(content).toEqual({
      type: "image",
      mimeType: "image/jpeg",
      data: Buffer.from(FAKE_JPEG).toString("base64"),
    });
    expect(frameTextContent(3.347)).toEqual({ type: "text", text: "Frame at 3.347s" });
  });

  it("handles payloads larger than one base64 chunk", () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    const content = frameToImageContent({ timestamp: 0, mimeType: "image/jpeg", data: big.buffer });
    expect(content.data).toBe(Buffer.from(big).toString("base64"));
  });
});
