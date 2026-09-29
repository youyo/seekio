export type CreateUploadInput = {
  filename?: string;
  maxDurationSeconds?: number;
};

export type ImportUrlInput = {
  url: string;
  filename?: string;
};

export type ImportedVideo = {
  videoId: string;
  status: VideoStatus;
};

export type Upload = {
  videoId: string;
  uploadUrl: string;
  expiresAt?: string;
};

export type VideoStatus =
  | "pendingupload"
  | "downloading"
  | "queued"
  | "inprogress"
  | "ready"
  | "error";

export type VideoInfo = {
  id: string;
  status: VideoStatus;
  duration?: number;
  width?: number;
  height?: number;
  createdAt?: string;
  /** Encoding progress (0-100) reported by the provider while processing. */
  pctComplete?: number;
};

/** A video Seekio created, as listed by the provider. `createdAt` is the provider's raw timestamp string. */
export type ListedVideo = {
  videoId: string;
  createdAt: string;
};

export type Frame = {
  timestamp: number;
  mimeType: "image/jpeg";
  data: ArrayBuffer;
};

export type FrameOptions = {
  /** Fetch at the source video's height instead of capping at the configured frame height. */
  fullResolution?: boolean;
  /**
   * How many times to retry the same time, with exponential backoff, when Stream answers HTTP 404
   * (thumbnails can be flaky for a while after a video becomes ready). Default 0.
   */
  maxNotFoundRetries?: number;
  /**
   * Whether a 4xx within the last second may be retried at slightly earlier times (up to 3 more
   * requests). Default true; multi-frame calls turn it off to stay within the subrequest limit.
   */
  retryEarlier?: boolean;
};

/** Languages Cloudflare Stream can generate captions for. There is no auto-detection. */
export const CAPTION_LANGUAGES = [
  "cs",
  "nl",
  "en",
  "fr",
  "de",
  "it",
  "ja",
  "ko",
  "pl",
  "pt",
  "ru",
  "es",
] as const;

export type CaptionLanguage = (typeof CAPTION_LANGUAGES)[number];

export type CaptionStatus = "ready" | "inprogress" | "error";

/** A caption track that exists for a video (the text itself comes from `getCaptionText`). */
export type Caption = {
  language: string;
  status: CaptionStatus;
};

/** The single seam between Seekio and the video provider. v1 ships only `CloudflareStreamBackend`. */
export interface VideoBackend {
  createUpload(input: CreateUploadInput): Promise<Upload>;
  importFromUrl(input: ImportUrlInput): Promise<ImportedVideo>;
  getInfo(videoId: string): Promise<VideoInfo>;
  getFrame(videoId: string, timestamp: number, options?: FrameOptions): Promise<Frame>;
  /** Caption tracks that exist for the video. Uploaded tracks without a status count as ready. */
  getCaptions(videoId: string): Promise<Caption[]>;
  /**
   * Starts AI caption generation for `language`. Resolves when it started, or when a caption for
   * that language already exists (generating twice is not an error). Throws NO_AUDIO_TRACK,
   * UNSUPPORTED_LANGUAGE or provider errors.
   */
  generateCaption(videoId: string, language: string): Promise<void>;
  /** The WebVTT body of a ready caption. Throws TRANSCRIPT_FAILED when it cannot be fetched. */
  getCaptionText(videoId: string, language: string): Promise<string>;
  /** Lists only the videos Seekio itself created (never other videos in the same account). */
  listVideos(): Promise<ListedVideo[]>;
  delete(videoId: string): Promise<void>;
}
