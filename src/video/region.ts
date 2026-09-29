import { SeekioError } from "../mcp/errors";

/** A rectangle as ratios (0-1) of the frame. Origin is the top-left corner. */
export type Region = { x: number; y: number; width: number; height: number };

export type PixelRect = { left: number; top: number; width: number; height: number };

/** Slack for floating point error in `x + width <= 1` (e.g. 0.7 + 0.3 style sums). */
const EPSILON = 1e-9;

const usage =
  "region is { x, y, width, height } as ratios of the frame between 0 and 1, with the origin at the top-left corner (x = left edge, y = top edge), width and height > 0, x + width <= 1 and y + height <= 1. Example: the bottom credits are { x: 0, y: 0.8, width: 1, height: 0.2 }.";

function invalid(reason: string): SeekioError {
  return new SeekioError(
    "INVALID_REGION",
    `Invalid region: ${reason}. ${usage} Fix the region and call video_frame again, or omit region to get the whole frame.`,
  );
}

/** Validates a region and returns it unchanged. Throws INVALID_REGION with a usage hint. */
export function validateRegion(region: Region): Region {
  const { x, y, width, height } = region;
  for (const [name, value] of Object.entries({ x, y, width, height })) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw invalid(`${name} (${value}) must be between 0 and 1`);
    }
  }
  if (width <= 0) throw invalid(`width (${width}) must be greater than 0`);
  if (height <= 0) throw invalid(`height (${height}) must be greater than 0`);
  if (x + width > 1 + EPSILON) throw invalid(`x + width (${x + width}) must not exceed 1`);
  if (y + height > 1 + EPSILON) throw invalid(`y + height (${y + height}) must not exceed 1`);
  return region;
}

/** Converts a ratio region to an integer pixel rectangle inside `frameWidth` x `frameHeight` (at least 1x1). */
export function regionToPixels(region: Region, frameWidth: number, frameHeight: number): PixelRect {
  const left = Math.min(frameWidth - 1, Math.max(0, Math.round(region.x * frameWidth)));
  const top = Math.min(frameHeight - 1, Math.max(0, Math.round(region.y * frameHeight)));
  const right = Math.min(frameWidth, Math.round((region.x + region.width) * frameWidth));
  const bottom = Math.min(frameHeight, Math.round((region.y + region.height) * frameHeight));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/** Shrinks (never enlarges) `width` x `height` so the long edge is at most `maxLongEdge`. */
export function fitLongEdge(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number; scaled: boolean } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height, scaled: false };
  const factor = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
    scaled: true,
  };
}

/** `x=0 y=0.8 w=1 h=0.2` for the tool's text caption. */
export function formatRegion(region: Region): string {
  return `x=${region.x} y=${region.y} w=${region.width} h=${region.height}`;
}
