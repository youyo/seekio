import { isSeekioError, SeekioError } from "../mcp/errors";
import type { Frame, FrameOptions, VideoBackend } from "./backend";

/** Fetches frames for `timestamps` with at most `concurrency` in flight; result order matches input order. */
export async function fetchFramesBounded(
  backend: VideoBackend,
  videoId: string,
  timestamps: readonly number[],
  concurrency: number,
  options?: FrameOptions,
): Promise<Frame[]> {
  const frames: Frame[] = new Array(timestamps.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < timestamps.length) {
      const index = next++;
      const timestamp = timestamps[index] as number;
      try {
        frames[index] = await backend.getFrame(videoId, timestamp, options);
      } catch (error) {
        if (isSeekioError(error)) throw error;
        throw new SeekioError(
          "FRAME_FETCH_FAILED",
          `Failed to fetch the frame at ${timestamp}s. Retry, or narrow the range.`,
        );
      }
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, timestamps.length)) },
    worker,
  );
  await Promise.all(workers);
  // A backend may fall back to an earlier time near the end of the video, which can collide with
  // another requested frame; keep the first frame per actual timestamp.
  const seen = new Set<number>();
  return frames.filter((frame) => {
    if (seen.has(frame.timestamp)) return false;
    seen.add(frame.timestamp);
    return true;
  });
}

export type ImageContent = { type: "image"; data: string; mimeType: "image/jpeg" };
export type TextContent = { type: "text"; text: string };

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function frameToImageContent(frame: Frame): ImageContent {
  return { type: "image", data: toBase64(frame.data), mimeType: frame.mimeType };
}

export function frameTextContent(timestamp: number): TextContent {
  return { type: "text", text: `Frame at ${timestamp}s` };
}
