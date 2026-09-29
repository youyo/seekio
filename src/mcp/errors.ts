export type SeekioErrorCode =
  | "VIDEO_NOT_FOUND"
  | "VIDEO_NOT_READY"
  | "VIDEO_PROCESSING_FAILED"
  | "INVALID_TIMESTAMP"
  | "INVALID_INTERVAL"
  | "TOO_MANY_FRAMES"
  | "INVALID_URL"
  | "URL_ALREADY_IMPORTED"
  | "VIDEO_TOO_LONG"
  | "UPLOAD_CREATE_FAILED"
  | "FRAME_FETCH_FAILED"
  | "INVALID_REGION"
  | "REGION_UNAVAILABLE"
  | "REGION_CROP_FAILED"
  | "BACKEND_ERROR";

/** An error whose message tells the agent what to do next. */
export class SeekioError extends Error {
  readonly code: SeekioErrorCode;

  constructor(code: SeekioErrorCode, message: string) {
    super(message);
    this.name = "SeekioError";
    this.code = code;
  }
}

export function isSeekioError(error: unknown): error is SeekioError {
  return error instanceof SeekioError;
}

export const messages = {
  notReady: "Video is still processing. Call video_info again before requesting frames.",
  processingFailed:
    "Video processing failed. Upload it again with video_create_upload or video_import_url.",
  invalidUrl: (detail: string) =>
    `Cloudflare Stream rejected the URL (${detail}). Check that it is a publicly reachable http(s) URL that downloads a video file directly (not a web page such as YouTube), then call video_import_url again.`,
  urlAlreadyImported:
    "This URL has already been imported into Cloudflare Stream. Use the existing video if you still have its video_id; otherwise delete the earlier video with video_delete and try importing again (re-import after deletion is not guaranteed to succeed).",
  tooLong: (duration: number, limit: number) =>
    `Video is ${duration}s long, but Seekio allows at most ${limit} seconds. Delete it with video_delete and use a shorter video.`,
  regionUnavailable:
    "Cropping a region is not available on this Seekio deployment (the Cloudflare Images binding is not configured). Call video_frame again without region to get the whole frame.",
  regionCropFailed: (code?: number) =>
    `Could not crop the region (Cloudflare Images failed${code === undefined ? "" : `, code ${code}`}). Call video_frame again without region to get the whole frame, or wait a while and retry (the Images free tier allows a limited number of transformations per month).`,
  notFound: (videoId: string) =>
    `Video ${videoId} was not found. Check the video_id or create a new upload.`,
} as const;
