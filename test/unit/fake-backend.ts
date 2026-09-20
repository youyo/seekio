import { messages, SeekioError } from "../../src/mcp/errors";
import type {
  CreateUploadInput,
  Frame,
  Upload,
  VideoBackend,
  VideoInfo,
} from "../../src/video/backend";

/** Minimal JPEG-looking payload (SOI marker + padding). */
export const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

export type FakeCall =
  | { op: "createUpload"; input: CreateUploadInput }
  | { op: "getInfo"; videoId: string }
  | { op: "getFrame"; videoId: string; timestamp: number }
  | { op: "delete"; videoId: string };

/** In-memory VideoBackend for tool tests. */
export class FakeVideoBackend implements VideoBackend {
  readonly videos = new Map<string, VideoInfo>();
  readonly calls: FakeCall[] = [];
  private nextId = 1;

  /** Adds a video; ready videos get a 10s duration and phone-like dimensions unless overridden. */
  addVideo(info: { id: string; status?: VideoInfo["status"]; duration?: number }): VideoInfo {
    const status = info.status ?? "ready";
    const video: VideoInfo = { id: info.id, status, width: 1179, height: 2556 };
    const duration = info.duration ?? (status === "ready" ? 10 : undefined);
    if (duration !== undefined) video.duration = duration;
    this.videos.set(video.id, video);
    return video;
  }

  async createUpload(input: CreateUploadInput): Promise<Upload> {
    this.calls.push({ op: "createUpload", input });
    const videoId = `fake-${this.nextId++}`;
    this.videos.set(videoId, { id: videoId, status: "pendingupload" });
    return {
      videoId,
      uploadUrl: `https://upload.example/${videoId}`,
      expiresAt: "2026-01-01T00:15:00.000Z",
    };
  }

  async getInfo(videoId: string): Promise<VideoInfo> {
    this.calls.push({ op: "getInfo", videoId });
    const video = this.videos.get(videoId);
    if (!video) throw new SeekioError("VIDEO_NOT_FOUND", messages.notFound(videoId));
    return video;
  }

  async getFrame(videoId: string, timestamp: number): Promise<Frame> {
    this.calls.push({ op: "getFrame", videoId, timestamp });
    return { timestamp, mimeType: "image/jpeg", data: FAKE_JPEG.slice().buffer };
  }

  async delete(videoId: string): Promise<void> {
    this.calls.push({ op: "delete", videoId });
    this.videos.delete(videoId);
  }
}
