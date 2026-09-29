import { messages, SeekioError } from "../mcp/errors";

/** Stream thumbnails at exactly `duration` fall off the end; stay just inside. */
const END_MARGIN_SECONDS = 0.001;
/** Absorbs binary floating point noise when comparing derived timestamps. */
const EPSILON = 1e-9;

/** Guards `x * 1000` landing just under an integer (e.g. 10.1 * 1000 = 10099.999...). */
const MS_EPSILON = 1e-6;

/**
 * Floors to milliseconds. Stream returns the first frame at or after the requested time, so
 * rounding up can skip a frame (10.0667 -> 10.067 lands one frame late at 30fps).
 */
function floor3(value: number): number {
  return Math.floor(value * 1000 + MS_EPSILON) / 1000;
}

function clampToVideo(timestamp: number, duration: number): number {
  return Math.max(0, Math.min(timestamp, duration - END_MARGIN_SECONDS));
}

function normalize(timestamps: number[], duration: number): number[] {
  const floored = timestamps.map((t) => floor3(clampToVideo(t, duration)));
  return [...new Set(floored)].sort((a, b) => a - b);
}

export type OverviewOptions = {
  maxFrames: number;
  intervalSeconds?: number;
};

/** Evenly spaced timestamps across the whole video (or fixed-interval when `intervalSeconds` is given). */
export function overviewTimestamps(duration: number, opts: OverviewOptions): number[] {
  if (!(duration > 0)) {
    throw new SeekioError("INVALID_INTERVAL", "Video duration is unknown or zero.");
  }
  if (!(opts.maxFrames >= 1)) {
    throw new SeekioError("INVALID_INTERVAL", "max_frames must be at least 1.");
  }
  const { intervalSeconds } = opts;
  if (intervalSeconds !== undefined) {
    if (!(intervalSeconds > 0)) {
      throw new SeekioError("INVALID_INTERVAL", "interval_seconds must be greater than 0.");
    }
    const count = Math.ceil(duration / intervalSeconds);
    if (count > opts.maxFrames) {
      throw new SeekioError(
        "TOO_MANY_FRAMES",
        `interval_seconds ${intervalSeconds} needs ${count} frames, but max_frames is ${opts.maxFrames}. Increase interval_seconds or max_frames.`,
      );
    }
    return normalize(
      Array.from({ length: count }, (_, i) => i * intervalSeconds),
      duration,
    );
  }
  const count = Math.floor(opts.maxFrames);
  if (count === 1) {
    return normalize([0], duration);
  }
  const timestamps = Array.from({ length: count }, (_, i) => (i * duration) / (count - 1));
  return normalize(timestamps, duration);
}

/**
 * Number of frames `video_frames` requests for `[start, end]` at `fps`, before clamping to the
 * video end and de-duplication: floor((end - start) * fps) + 1. `end` itself is included when it
 * lies exactly on the `start + i / fps` grid.
 */
export function frameCount(start: number, end: number, fps: number): number {
  // Floating point guard: (end - start) * fps may land just under an integer.
  return Math.floor((end - start) * fps + EPSILON) + 1;
}

/** Largest `end` (millisecond precision, floored) for which `frameCount` stays within `maxFrames`. */
export function maxEndForFrames(start: number, fps: number, maxFrames: number): number {
  return floor3(start + (maxFrames - 1) / fps);
}

/**
 * Highest `fps` (0.001 steps, floored) for which `[start, end]` yields at most `maxFrames`
 * frames, or undefined when even 0.001 fps is too high.
 */
export function maxFpsForRange(start: number, end: number, maxFrames: number): number | undefined {
  const fps = floor3((maxFrames - 1) / (end - start));
  return fps > 0 ? fps : undefined;
}

export type FrameRange = {
  start: number;
  end: number;
  fps: number;
  duration: number;
};

export type FrameLimits = {
  maxFps: number;
  maxFramesPerCall: number;
};

/** Deterministic timestamps for `[start, end]` at `fps`; never degrades fps silently. */
export function frameTimestamps(range: FrameRange, limits: FrameLimits): number[] {
  const { start, end, fps, duration } = range;
  if (!(duration > 0)) {
    throw new SeekioError("VIDEO_NOT_READY", "Video duration is unknown. Call video_info first.");
  }
  if (!(start >= 0)) {
    throw new SeekioError("INVALID_INTERVAL", "start must be greater than or equal to 0.");
  }
  if (!(end > start)) {
    throw new SeekioError("INVALID_INTERVAL", "end must be greater than start.");
  }
  if (end > duration) {
    throw new SeekioError(
      "INVALID_INTERVAL",
      `end (${end}s) exceeds the video duration (${duration}s).`,
    );
  }
  if (!(fps > 0)) {
    throw new SeekioError("INVALID_INTERVAL", "fps must be greater than 0.");
  }
  if (fps > limits.maxFps) {
    throw new SeekioError(
      "INVALID_INTERVAL",
      `fps ${fps} exceeds the maximum of ${limits.maxFps}. Reduce fps.`,
    );
  }
  const count = frameCount(start, end, fps);
  if (count > limits.maxFramesPerCall) {
    const max = limits.maxFramesPerCall;
    throw new SeekioError(
      "TOO_MANY_FRAMES",
      messages.tooManyFrames({
        requested: count,
        start,
        end,
        fps,
        maxFrames: max,
        maxEnd: maxEndForFrames(start, fps, max),
        maxFps: maxFpsForRange(start, end, max),
      }),
    );
  }
  const timestamps = Array.from({ length: count }, (_, index) => start + index / fps).filter(
    (t) => t <= end + EPSILON,
  );
  return normalize(timestamps, duration);
}

/** Validates a single timestamp for `video_frame` and returns it floored to milliseconds. */
export function validateFrameAt(at: number, duration: number): number {
  if (!(duration > 0)) {
    throw new SeekioError("VIDEO_NOT_READY", "Video duration is unknown. Call video_info first.");
  }
  const rounded = floor3(at);
  if (!(rounded >= 0) || rounded >= duration) {
    throw new SeekioError(
      "INVALID_TIMESTAMP",
      `at must satisfy 0 <= at < ${duration} (video duration). Received ${at}.`,
    );
  }
  return rounded;
}
