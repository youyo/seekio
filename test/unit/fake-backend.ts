import { messages, SeekioError } from "../../src/mcp/errors";
import type {
  CreateUploadInput,
  Frame,
  FrameOptions,
  ImportedVideo,
  ImportUrlInput,
  ListedVideo,
  Upload,
  VideoBackend,
  VideoInfo,
} from "../../src/video/backend";

/** Minimal JPEG-looking payload (SOI marker + padding). */
export const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

export type FakeCall =
  | { op: "createUpload"; input: CreateUploadInput }
  | { op: "importFromUrl"; input: ImportUrlInput }
  | { op: "getInfo"; videoId: string }
  | { op: "getFrame"; videoId: string; timestamp: number; fullResolution?: true }
  | { op: "delete"; videoId: string }
  | { op: "listVideos" };

/** In-memory VideoBackend for tool tests. */
export class FakeVideoBackend implements VideoBackend {
  readonly videos = new Map<string, VideoInfo>();
  readonly calls: FakeCall[] = [];
  /** When set, `importFromUrl` throws it instead of creating a video. */
  importError: Error | undefined;
  /** Video ids whose `delete` throws. */
  readonly failDeleteIds = new Set<string>();
  private nextId = 1;
  private readonly infoSequences = new Map<string, VideoInfo[]>();

  /** Makes successive `getInfo` calls return these states in order; the last one repeats. */
  /** When set, createUpload returns this upload URL instead of the default. */
  uploadUrlOverride?: string;

  setInfoSequence(videoId: string, states: VideoInfo[]): void {
    this.infoSequences.set(videoId, [...states]);
  }

  /** Adds a video; ready videos get a 10s duration and phone-like dimensions unless overridden. */
  addVideo(info: {
    id: string;
    status?: VideoInfo["status"];
    duration?: number;
    createdAt?: string;
  }): VideoInfo {
    const status = info.status ?? "ready";
    const video: VideoInfo = { id: info.id, status, width: 1179, height: 2556 };
    const duration = info.duration ?? (status === "ready" ? 10 : undefined);
    if (duration !== undefined) video.duration = duration;
    if (info.createdAt !== undefined) video.createdAt = info.createdAt;
    this.videos.set(video.id, video);
    return video;
  }

  async createUpload(input: CreateUploadInput): Promise<Upload> {
    this.calls.push({ op: "createUpload", input });
    const videoId = `fake-${this.nextId++}`;
    this.videos.set(videoId, { id: videoId, status: "pendingupload" });
    return {
      videoId,
      uploadUrl: this.uploadUrlOverride ?? `https://upload.example/${videoId}`,
      expiresAt: "2026-01-01T00:15:00.000Z",
    };
  }

  async importFromUrl(input: ImportUrlInput): Promise<ImportedVideo> {
    this.calls.push({ op: "importFromUrl", input });
    if (this.importError) throw this.importError;
    const videoId = `fake-${this.nextId++}`;
    this.videos.set(videoId, { id: videoId, status: "downloading" });
    return { videoId, status: "downloading" };
  }

  async getInfo(videoId: string): Promise<VideoInfo> {
    this.calls.push({ op: "getInfo", videoId });
    const sequence = this.infoSequences.get(videoId);
    if (sequence && sequence.length > 0) {
      const next = sequence.length > 1 ? sequence.shift() : sequence[0];
      if (next) return next;
    }
    const video = this.videos.get(videoId);
    if (!video) throw new SeekioError("VIDEO_NOT_FOUND", messages.notFound(videoId));
    return video;
  }

  async getFrame(videoId: string, timestamp: number, options?: FrameOptions): Promise<Frame> {
    this.calls.push({
      op: "getFrame",
      videoId,
      timestamp,
      ...(options?.fullResolution && { fullResolution: true as const }),
    });
    return { timestamp, mimeType: "image/jpeg", data: FAKE_JPEG.slice().buffer };
  }

  /** Every stored video is treated as created by Seekio; videos without `createdAt` list an empty one. */
  async listVideos(): Promise<ListedVideo[]> {
    this.calls.push({ op: "listVideos" });
    return [...this.videos.values()].map((v) => ({ videoId: v.id, createdAt: v.createdAt ?? "" }));
  }

  async delete(videoId: string): Promise<void> {
    this.calls.push({ op: "delete", videoId });
    if (this.failDeleteIds.has(videoId)) throw new Error(`delete failed for ${videoId}`);
    this.videos.delete(videoId);
  }
}
