export type SeekioErrorCode =
  | "VIDEO_NOT_FOUND"
  | "VIDEO_NOT_READY"
  | "VIDEO_PROCESSING_FAILED"
  | "INVALID_TIMESTAMP"
  | "INVALID_INTERVAL"
  | "TOO_MANY_FRAMES"
  | "UPLOAD_CREATE_FAILED"
  | "FRAME_FETCH_FAILED"
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
  processingFailed: "Video processing failed. Upload the video again with video_create_upload.",
  notFound: (videoId: string) =>
    `Video ${videoId} was not found. Check the video_id or create a new upload.`,
} as const;
