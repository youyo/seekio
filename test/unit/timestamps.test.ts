import { describe, expect, it } from "vitest";
import { defaults } from "../../src/config";
import { SeekioError } from "../../src/mcp/errors";
import { frameTimestamps, overviewTimestamps, validateFrameAt } from "../../src/video/timestamps";

const limits = { maxFps: defaults.maxFps, maxFramesPerCall: defaults.maxFramesPerCall };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof SeekioError) return error.code;
    throw error;
  }
  return undefined;
}

describe("overviewTimestamps", () => {
  it("spreads max_frames evenly across the duration and clamps the last frame", () => {
    const ts = overviewTimestamps(10, { maxFrames: 5 });
    expect(ts).toEqual([0, 2.5, 5, 7.5, 9.999]);
  });

  it("defaults to 12 frames for a long video", () => {
    const ts = overviewTimestamps(120, { maxFrames: defaults.overviewMaxFrames });
    expect(ts).toHaveLength(12);
    expect(ts[0]).toBe(0);
    expect(ts.at(-1)).toBe(119.999);
  });

  it("removes duplicate timestamps produced by very short videos", () => {
    const ts = overviewTimestamps(0.002, { maxFrames: 12 });
    expect(ts).toEqual([0, 0.001]);
  });

  it("returns [0] for a single frame", () => {
    expect(overviewTimestamps(30, { maxFrames: 1 })).toEqual([0]);
  });

  it("uses a fixed interval when interval_seconds is set and refuses to cover only part of the video", () => {
    expect(overviewTimestamps(10, { maxFrames: 12, intervalSeconds: 3 })).toEqual([0, 3, 6, 9]);
    expect(overviewTimestamps(0.3, { maxFrames: 12, intervalSeconds: 0.1 })).toEqual([0, 0.1, 0.2]);
    expect(codeOf(() => overviewTimestamps(10, { maxFrames: 2, intervalSeconds: 3 }))).toBe(
      "TOO_MANY_FRAMES",
    );
  });

  it("rejects unusable durations and intervals", () => {
    expect(codeOf(() => overviewTimestamps(0, { maxFrames: 12 }))).toBe("INVALID_INTERVAL");
    expect(codeOf(() => overviewTimestamps(10, { maxFrames: 12, intervalSeconds: 0 }))).toBe(
      "INVALID_INTERVAL",
    );
    expect(codeOf(() => overviewTimestamps(10, { maxFrames: 0 }))).toBe("INVALID_INTERVAL");
  });
});

describe("frameTimestamps", () => {
  it("computes start + index / fps without accumulating floating point error", () => {
    const ts = frameTimestamps({ start: 3.2, end: 3.6, fps: 20, duration: 10 }, limits);
    expect(ts).toEqual([3.2, 3.25, 3.3, 3.35, 3.4, 3.45, 3.5, 3.55, 3.6]);
  });

  it("uses the default fps of 5", () => {
    const ts = frameTimestamps(
      { start: 0, end: 1, fps: defaults.defaultFramesFps, duration: 10 },
      limits,
    );
    expect(ts).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it("clamps the final frame to just before the end of the video", () => {
    const ts = frameTimestamps({ start: 9, end: 10, fps: 1, duration: 10 }, limits);
    expect(ts).toEqual([9, 9.999]);
  });

  it("refuses more than MAX_FRAMES_PER_CALL frames with an actionable message", () => {
    let caught: unknown;
    try {
      frameTimestamps({ start: 0, end: 6, fps: 10, duration: 10 }, limits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SeekioError);
    expect((caught as SeekioError).code).toBe("TOO_MANY_FRAMES");
    expect((caught as SeekioError).message).toBe(
      "Requested 61 frames, but Seekio allows at most 30 frames per call. Narrow the interval or reduce fps.",
    );
  });

  it("allows exactly MAX_FRAMES_PER_CALL frames", () => {
    const ts = frameTimestamps({ start: 0, end: 2.9, fps: 10, duration: 10 }, limits);
    expect(ts).toHaveLength(30);
  });

  it("rejects fps above MAX_FPS instead of degrading it", () => {
    expect(
      codeOf(() => frameTimestamps({ start: 0, end: 0.1, fps: 31, duration: 10 }, limits)),
    ).toBe("INVALID_INTERVAL");
    expect(frameTimestamps({ start: 0, end: 0.1, fps: 30, duration: 10 }, limits)).toHaveLength(4);
  });

  it("validates start/end against each other and the duration", () => {
    expect(codeOf(() => frameTimestamps({ start: -1, end: 1, fps: 5, duration: 10 }, limits))).toBe(
      "INVALID_INTERVAL",
    );
    expect(codeOf(() => frameTimestamps({ start: 2, end: 2, fps: 5, duration: 10 }, limits))).toBe(
      "INVALID_INTERVAL",
    );
    expect(codeOf(() => frameTimestamps({ start: 0, end: 11, fps: 5, duration: 10 }, limits))).toBe(
      "INVALID_INTERVAL",
    );
    expect(codeOf(() => frameTimestamps({ start: 0, end: 1, fps: 0, duration: 10 }, limits))).toBe(
      "INVALID_INTERVAL",
    );
    expect(codeOf(() => frameTimestamps({ start: 0, end: 1, fps: 5, duration: 0 }, limits))).toBe(
      "VIDEO_NOT_READY",
    );
  });
});

describe("validateFrameAt", () => {
  it("accepts sub-second timestamps inside the video", () => {
    expect(validateFrameAt(3.3474, 10)).toBe(3.347);
    expect(validateFrameAt(0, 10)).toBe(0);
    expect(validateFrameAt(9.9994, 10)).toBe(9.999);
  });

  it("rejects timestamps outside [0, duration)", () => {
    expect(codeOf(() => validateFrameAt(10, 10))).toBe("INVALID_TIMESTAMP");
    expect(codeOf(() => validateFrameAt(9.9996, 10))).toBe("INVALID_TIMESTAMP");
    expect(codeOf(() => validateFrameAt(-0.1, 10))).toBe("INVALID_TIMESTAMP");
    expect(codeOf(() => validateFrameAt(1, 0))).toBe("VIDEO_NOT_READY");
  });
});
