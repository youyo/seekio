import { describe, expect, it } from "vitest";
import { defaults } from "../../src/config";
import { SeekioError } from "../../src/mcp/errors";
import {
  frameCount,
  frameTimestamps,
  maxEndForFrames,
  maxFpsForRange,
  overviewTimestamps,
  validateFrameAt,
} from "../../src/video/timestamps";

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

  it("floors instead of rounding, without losing exact millisecond values to float noise", () => {
    expect(overviewTimestamps(10, { maxFrames: 4 })).toEqual([0, 3.333, 6.666, 9.999]);
    expect(overviewTimestamps(52.21, { maxFrames: 2 })).toEqual([0, 52.209]);
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

  it("floors to milliseconds so Stream's next-frame-at-or-after lookup does not skip a frame", () => {
    const ts = frameTimestamps({ start: 10, end: 10.1, fps: 30, duration: 60 }, limits);
    expect(ts).toEqual([10, 10.033, 10.066, 10.1]);
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
      frameTimestamps({ start: 0, end: 1.5, fps: 10, duration: 10 }, limits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SeekioError);
    expect((caught as SeekioError).code).toBe("TOO_MANY_FRAMES");
    expect((caught as SeekioError).message).toBe(
      "Requested 16 frames (start 0s, end 1.5s, fps 10), but Seekio allows at most 15 frames per call. The frame count is floor((end - start) * fps) + 1. With start 0 and fps 10, end can be at most 1.4s. To keep end at 1.5s, lower fps to 9.333 or less. Or narrow the range.",
    );
  });

  it("allows exactly MAX_FRAMES_PER_CALL frames", () => {
    const ts = frameTimestamps({ start: 0, end: 1.4, fps: 10, duration: 10 }, limits);
    expect(ts).toHaveLength(15);
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
    expect(validateFrameAt(10.0667, 60)).toBe(10.066);
    expect(validateFrameAt(10.1, 60)).toBe(10.1);
  });

  it("rejects timestamps outside [0, duration)", () => {
    expect(codeOf(() => validateFrameAt(10, 10))).toBe("INVALID_TIMESTAMP");
    expect(codeOf(() => validateFrameAt(-0.1, 10))).toBe("INVALID_TIMESTAMP");
    expect(codeOf(() => validateFrameAt(1, 0))).toBe("VIDEO_NOT_READY");
  });
});

describe("frameCount", () => {
  it("matches the feedback examples (end is included when it lands on the frame grid)", () => {
    expect(frameCount(0, 13, 1)).toBe(14);
    expect(frameCount(138, 150.8, 1)).toBe(13);
  });

  it("is floor((end - start) * fps) + 1 and agrees with frameTimestamps", () => {
    expect(frameCount(0, 1.4, 10)).toBe(15);
    expect(frameCount(0, 1.5, 10)).toBe(16);
    expect(frameCount(0, 14, 1)).toBe(15);
    expect(frameCount(0, 0.3, 10)).toBe(4); // 0.3 * 10 = 3.0000000000000004 / float noise safe
    expect(frameTimestamps({ start: 138, end: 150.8, fps: 1, duration: 200 }, limits)).toHaveLength(
      13,
    );
  });
});

describe("maxEndForFrames", () => {
  it("returns the largest end (ms precision) that fits the frame budget", () => {
    expect(maxEndForFrames(0, 1, 15)).toBe(14);
    expect(maxEndForFrames(0, 10, 15)).toBe(1.4);
    expect(maxEndForFrames(138, 1, 15)).toBe(152);
    expect(maxEndForFrames(0, 3, 15)).toBe(4.666);
  });

  it("fits exactly the budget at the boundary and overflows one millisecond-step past it", () => {
    for (const [start, fps] of [
      [0, 1],
      [0, 10],
      [138, 1],
      [0.1, 3],
      [2.4, 20],
    ] as const) {
      const end = maxEndForFrames(start, fps, 15);
      expect(frameCount(start, end, fps)).toBeLessThanOrEqual(15);
      expect(frameCount(start, end + 1 / fps, fps)).toBe(frameCount(start, end, fps) + 1);
    }
    expect(frameCount(0, maxEndForFrames(0, 1, 15), 1)).toBe(15);
    expect(frameCount(0, maxEndForFrames(0, 1, 15) + 1, 1)).toBe(16);
  });
});

describe("maxFpsForRange", () => {
  it("returns the highest fps (0.001 steps) that fits the range in the budget", () => {
    expect(maxFpsForRange(0, 1.5, 15)).toBe(9.333);
    expect(maxFpsForRange(0, 14, 15)).toBe(1);
    expect(frameCount(0, 1.5, 9.333)).toBeLessThanOrEqual(15);
  });

  it("returns undefined when even 0.001 fps cannot fit", () => {
    expect(maxFpsForRange(0, 100000, 15)).toBeUndefined();
  });
});

describe("frameTimestamps boundary", () => {
  it("allows exactly 15 frames and refuses 16 with the counts in the message", () => {
    expect(frameTimestamps({ start: 0, end: 14, fps: 1, duration: 100 }, limits)).toHaveLength(15);
    let message = "";
    try {
      frameTimestamps({ start: 0, end: 15, fps: 1, duration: 100 }, limits);
    } catch (error) {
      message = (error as SeekioError).message;
    }
    expect(message).toContain("Requested 16 frames");
    expect(message).toContain("end can be at most 14s");
  });
});
