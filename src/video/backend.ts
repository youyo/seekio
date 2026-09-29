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
};

/** The single seam between Seekio and the video provider. v1 ships only `CloudflareStreamBackend`. */
export interface VideoBackend {
  createUpload(input: CreateUploadInput): Promise<Upload>;
  importFromUrl(input: ImportUrlInput): Promise<ImportedVideo>;
  getInfo(videoId: string): Promise<VideoInfo>;
  getFrame(videoId: string, timestamp: number, options?: FrameOptions): Promise<Frame>;
  /** Lists only the videos Seekio itself created (never other videos in the same account). */
  listVideos(): Promise<ListedVideo[]>;
  delete(videoId: string): Promise<void>;
}
