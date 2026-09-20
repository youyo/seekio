import { messages, SeekioError } from "../mcp/errors";
import type {
  CreateUploadInput,
  Frame,
  Upload,
  VideoBackend,
  VideoInfo,
  VideoStatus,
} from "./backend";

export type CloudflareStreamOptions = {
  frameHeight: number;
  uploadUrlTtlSeconds: number;
  maxVideoDurationSeconds: number;
};

const VIDEO_STATUSES: readonly VideoStatus[] = [
  "pendingupload",
  "downloading",
  "queued",
  "inprogress",
  "ready",
  "error",
];

function isVideoStatus(state: string): state is VideoStatus {
  return (VIDEO_STATUSES as readonly string[]).includes(state);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundError";
}

function backendError(error: unknown, action: string): SeekioError {
  const detail = error instanceof Error ? error.message : String(error);
  return new SeekioError("BACKEND_ERROR", `Cloudflare Stream failed to ${action}: ${detail}`);
}

/** Cloudflare Stream implementation of `VideoBackend`. One instance per request. */
export class CloudflareStreamBackend implements VideoBackend {
  private readonly stream: StreamBinding;
  private readonly options: CloudflareStreamOptions;
  /** Per-video signed thumbnail base (`<origin>/<token>`), memoized for the life of this instance. */
  private readonly thumbnailBases = new Map<string, Promise<string>>();

  constructor(stream: StreamBinding, options: CloudflareStreamOptions) {
    this.stream = stream;
    this.options = options;
  }

  async createUpload(input: CreateUploadInput): Promise<Upload> {
    const expiresAt = new Date(Date.now() + this.options.uploadUrlTtlSeconds * 1000).toISOString();
    const meta: Record<string, string> = { application: "seekio" };
    if (input.filename) meta.filename = input.filename;
    try {
      const upload = await this.stream.createDirectUpload({
        maxDurationSeconds: input.maxDurationSeconds ?? this.options.maxVideoDurationSeconds,
        expiry: expiresAt,
        requireSignedURLs: true,
        meta,
      });
      return { videoId: upload.id, uploadUrl: upload.uploadURL, expiresAt };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SeekioError("UPLOAD_CREATE_FAILED", `Could not create an upload URL: ${detail}`);
    }
  }

  async getInfo(videoId: string): Promise<VideoInfo> {
    const video = await this.details(videoId);
    const state = video.status.state;
    if (!isVideoStatus(state)) {
      throw new SeekioError(
        "BACKEND_ERROR",
        `Cloudflare Stream returned an unknown status "${state}".`,
      );
    }
    const ready = state === "ready" && video.readyToStream;
    const info: VideoInfo = { id: video.id, status: state };
    if (ready && video.duration > 0) info.duration = video.duration;
    if (video.input?.width > 0) info.width = video.input.width;
    if (video.input?.height > 0) info.height = video.input.height;
    if (video.created) info.createdAt = video.created;
    return info;
  }

  async getFrame(videoId: string, timestamp: number): Promise<Frame> {
    const base = await this.thumbnailBase(videoId);
    const url = new URL(`${base}/thumbnails/thumbnail.jpg`);
    url.searchParams.set("time", `${timestamp}s`);
    url.searchParams.set("height", String(this.options.frameHeight));
    url.searchParams.set("fit", "scale");
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new SeekioError(
        "FRAME_FETCH_FAILED",
        `Could not reach Cloudflare Stream for the frame at ${timestamp}s: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new SeekioError(
        "FRAME_FETCH_FAILED",
        `Cloudflare Stream returned HTTP ${response.status} for the frame at ${timestamp}s.`,
      );
    }
    return { timestamp, mimeType: "image/jpeg", data: await response.arrayBuffer() };
  }

  async delete(videoId: string): Promise<void> {
    try {
      await this.stream.video(videoId).delete();
    } catch (error) {
      if (isNotFound(error)) return;
      throw backendError(error, `delete video ${videoId}`);
    }
  }

  private async details(videoId: string): Promise<StreamVideo> {
    try {
      return await this.stream.video(videoId).details();
    } catch (error) {
      if (isNotFound(error)) throw new SeekioError("VIDEO_NOT_FOUND", messages.notFound(videoId));
      throw backendError(error, `read video ${videoId}`);
    }
  }

  private thumbnailBase(videoId: string): Promise<string> {
    let base = this.thumbnailBases.get(videoId);
    if (!base) {
      base = (async () => {
        const video = await this.details(videoId);
        const origin = new URL(video.thumbnail).origin;
        let token: string;
        try {
          token = await this.stream.video(videoId).generateToken();
        } catch (error) {
          throw backendError(error, `sign video ${videoId}`);
        }
        return `${origin}/${token}`;
      })();
      this.thumbnailBases.set(videoId, base);
    }
    return base;
  }
}
