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
};

export type Frame = {
  timestamp: number;
  mimeType: "image/jpeg";
  data: ArrayBuffer;
};

/** The single seam between Seekio and the video provider. v1 ships only `CloudflareStreamBackend`. */
export interface VideoBackend {
  createUpload(input: CreateUploadInput): Promise<Upload>;
  importFromUrl(input: ImportUrlInput): Promise<ImportedVideo>;
  getInfo(videoId: string): Promise<VideoInfo>;
  getFrame(videoId: string, timestamp: number): Promise<Frame>;
  delete(videoId: string): Promise<void>;
}
