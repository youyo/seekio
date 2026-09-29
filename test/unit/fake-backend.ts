import { messages, SeekioError } from "../../src/mcp/errors";
import type {
  Caption,
  CaptionStatus,
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
  | { op: "getCaptions"; videoId: string }
  | { op: "generateCaption"; videoId: string; language: string }
  | { op: "getCaptionText"; videoId: string; language: string }
  | { op: "delete"; videoId: string }
  | { op: "listVideos" };

/** In-memory VideoBackend for tool tests. */
export class FakeVideoBackend implements VideoBackend {
  readonly videos = new Map<string, VideoInfo>();
  readonly calls: FakeCall[] = [];
  /** `maxNotFoundRetries` passed to each `getFrame` call, in order. */
  readonly frameRetryBudgets: Array<number | undefined> = [];
  /** `retryEarlier` passed to each `getFrame` call, in order. */
  readonly frameRetryEarlier: Array<boolean | undefined> = [];
  /** When set, `importFromUrl` throws it instead of creating a video. */
  importError: Error | undefined;
  /** Video ids whose `delete` throws. */
  readonly failDeleteIds = new Set<string>();
  /** Caption tracks per video and language. */
  readonly captions = new Map<
    string,
    Map<string, { status: CaptionStatus; vtt: string; listsUntilReady: number }>
  >();
  /** WebVTT that `generateCaption` produces, per language (default: a one-cue track). */
  readonly generatedVtt = new Map<string, string>();
  /** How many `getCaptions` calls report a generated caption as inprogress before it is ready. */
  listsUntilReady = 1;
  /** Errors `generateCaption` throws, per language. */
  readonly generateErrors = new Map<string, Error>();
  /** Languages whose caption text fetch fails. */
  readonly failTextLanguages = new Set<string>();
  private nextId = 1;
  private readonly infoSequences = new Map<string, VideoInfo[]>();

  /** Makes successive `getInfo` calls return these states in order; the last one repeats. */
  /** When set, createUpload returns this upload URL instead of the default. */
  uploadUrlOverride?: string;
  /** When set, createUpload returns this video id instead of the default. */
  videoIdOverride?: string;

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
    const videoId = this.videoIdOverride ?? `fake-${this.nextId++}`;
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
    this.frameRetryBudgets.push(options?.maxNotFoundRetries);
    this.frameRetryEarlier.push(options?.retryEarlier);
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

  /** Adds a caption track directly (an existing or already generated one). */
  setCaption(
    videoId: string,
    language: string,
    caption: { status?: CaptionStatus; vtt?: string; listsUntilReady?: number },
  ): void {
    const tracks = this.captions.get(videoId) ?? new Map();
    tracks.set(language, {
      status: caption.status ?? "ready",
      vtt: caption.vtt ?? defaultVtt(language),
      listsUntilReady: caption.listsUntilReady ?? 0,
    });
    this.captions.set(videoId, tracks);
  }

  async getCaptions(videoId: string): Promise<Caption[]> {
    this.calls.push({ op: "getCaptions", videoId });
    if (!this.videos.has(videoId)) {
      throw new SeekioError("VIDEO_NOT_FOUND", messages.notFound(videoId));
    }
    const result: Caption[] = [];
    for (const [language, track] of this.captions.get(videoId) ?? []) {
      if (track.status === "inprogress" && track.listsUntilReady <= 0) track.status = "ready";
      result.push({ language, status: track.status });
      if (track.status === "inprogress") track.listsUntilReady--;
    }
    return result;
  }

  async generateCaption(videoId: string, language: string): Promise<void> {
    this.calls.push({ op: "generateCaption", videoId, language });
    const error = this.generateErrors.get(language);
    if (error) throw error;
    if (this.captions.get(videoId)?.has(language)) return;
    this.setCaption(videoId, language, {
      status: "inprogress",
      vtt: this.generatedVtt.get(language) ?? defaultVtt(language),
      listsUntilReady: this.listsUntilReady,
    });
  }

  async getCaptionText(videoId: string, language: string): Promise<string> {
    this.calls.push({ op: "getCaptionText", videoId, language });
    const track = this.captions.get(videoId)?.get(language);
    if (!track || track.status !== "ready" || this.failTextLanguages.has(language)) {
      throw new SeekioError("TRANSCRIPT_FAILED", messages.transcriptFailed(language, "HTTP 404"));
    }
    return track.vtt;
  }
}

/** A small track: one normal cue, one zero-length cue. */
export function defaultVtt(language: string): string {
  return `WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nhello ${language}\n\n00:00:04.000 --> 00:00:04.000\nzero\n\n00:00:08.000 --> 00:00:09.000\nlater ${language}\n`;
}
