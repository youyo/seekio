import { messages, SeekioError } from "../mcp/errors";
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
  VideoStatus,
} from "./backend";

export type CloudflareStreamOptions = {
  frameHeight: number;
  uploadUrlTtlSeconds: number;
  maxVideoDurationSeconds: number;
  /** Clock in epoch milliseconds. Defaults to `Date.now`; tests inject a fixed one. */
  now?: () => number;
};

/**
 * Stream only accepts a scheduledDeletion at least 30 days after upload, so it cannot enforce the
 * short retention (the cron cleanup does). 31 days is a safety net that clears that minimum.
 */
const SAFETY_NET_DELETION_DAYS = 31;

/** `videos.list` page size. */
const LIST_PAGE_SIZE = 100;
/** Upper bound on list pages per cleanup run (guards against a runaway loop). */
const LIST_MAX_PAGES = 100;

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

/**
 * Stream error kind, e.g. "QuotaReachedError". In-process bindings keep it in `error.name`;
 * through a remote binding `name` is a plain "Error" and the kind is the message prefix
 * ("QuotaReachedError: ..."). Returns undefined when neither carries one.
 */
function streamErrorName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (/^[A-Z]\w*Error$/.test(error.name) && error.name !== "Error") return error.name;
  return /^(\w+Error):/.exec(error.message)?.[1];
}

function isNotFound(error: unknown): boolean {
  return streamErrorName(error) === "NotFoundError";
}

function importError(error: unknown): SeekioError {
  const name = streamErrorName(error);
  // Only INVALID_URL may echo the Stream message: it is never logged. Other codes are logged
  // (backend.error) and the message can contain the source URL, so they use fixed text.
  const detail = error instanceof Error ? error.message : String(error);
  switch (name) {
    case "BadRequestError":
      return new SeekioError("INVALID_URL", messages.invalidUrl(detail));
    case "AlreadyUploadedError":
      return new SeekioError("URL_ALREADY_IMPORTED", messages.urlAlreadyImported);
    case "MaxFileSizeError":
      return new SeekioError(
        "UPLOAD_CREATE_FAILED",
        "Could not import the URL: the file exceeds the maximum file size Cloudflare Stream accepts. Use a smaller video.",
      );
    case "QuotaReachedError":
      return new SeekioError(
        "UPLOAD_CREATE_FAILED",
        "Could not import the URL: the Cloudflare Stream storage quota is reached. Delete unused videos with video_delete and try again.",
      );
    case "RateLimitedError":
      return new SeekioError(
        "UPLOAD_CREATE_FAILED",
        "Could not import the URL: Cloudflare Stream rate limit hit. Wait a moment and try again.",
      );
    default:
      return new SeekioError(
        "UPLOAD_CREATE_FAILED",
        `Could not import the URL: Cloudflare Stream failed (${name ?? "unknown error"}). Try again later, or check the URL and use video_create_upload instead.`,
      );
  }
}

/** Only frames this close to the end are retried earlier on HTTP 4xx (Stream rejects some times at the very end). */
const END_RETRY_WINDOW_SECONDS = 1;
/** How far before the requested time each retry goes. */
const RETRY_OFFSETS_SECONDS = [0.1, 0.5, 1.0];

/** Fallback times strictly before `timestamp`, in ms precision, never below 0, without duplicates. */
function retryTimestamps(timestamp: number): number[] {
  const candidates = RETRY_OFFSETS_SECONDS.map((offset) =>
    Math.max(0, Math.round((timestamp - offset) * 1000) / 1000),
  );
  return [...new Set(candidates)].filter((t) => t < timestamp);
}

/**
 * Releases an RPC stub (or a result that contains stubs) held through a Workers binding.
 * Calls `Symbol.dispose` only when it exists, so in-process bindings and plain objects are fine.
 */
function disposeStub(value: unknown): void {
  const key = (Symbol as { dispose?: symbol }).dispose;
  if (!key || value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const dispose = (value as Record<symbol, unknown>)[key];
  if (typeof dispose !== "function") return;
  try {
    dispose.call(value);
  } catch {
    // Disposal is best effort; it must never mask the real result or error.
  }
}

/** The fields of `StreamVideo` Seekio reads, copied out so the RPC result can be disposed. */
type VideoDetails = Pick<
  StreamVideo,
  "id" | "readyToStream" | "duration" | "created" | "thumbnail"
> & {
  state: string;
  pctComplete: string | undefined;
  width: number | undefined;
  height: number | undefined;
};

function copyDetails(video: StreamVideo): VideoDetails {
  return {
    id: video.id,
    readyToStream: video.readyToStream,
    duration: video.duration,
    created: video.created,
    thumbnail: video.thumbnail,
    state: video.status.state,
    pctComplete: video.status.pctComplete,
    width: video.input?.width,
    height: video.input?.height,
  };
}

type ThumbnailSource = {
  base: string;
  /** min(source height, frameHeight); the source height itself is unknown when 0. */
  height: number;
  /** Source video height (unknown -> frameHeight). */
  fullHeight: number;
  duration: number;
};

function backendError(error: unknown, action: string): SeekioError {
  const detail = error instanceof Error ? error.message : String(error);
  return new SeekioError("BACKEND_ERROR", `Cloudflare Stream failed to ${action}: ${detail}`);
}

/** Cloudflare Stream implementation of `VideoBackend`. One instance per request. */
export class CloudflareStreamBackend implements VideoBackend {
  private readonly stream: StreamBinding;
  private readonly options: CloudflareStreamOptions;
  /** Per-video signed thumbnail base (`<origin>/<token>`), memoized for the life of this instance. */
  private readonly thumbnailSources = new Map<string, Promise<ThumbnailSource>>();

  constructor(stream: StreamBinding, options: CloudflareStreamOptions) {
    this.stream = stream;
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private safetyNetDeletion(): string {
    return new Date(this.now() + SAFETY_NET_DELETION_DAYS * 86_400_000).toISOString();
  }

  async createUpload(input: CreateUploadInput): Promise<Upload> {
    const expiresAt = new Date(this.now() + this.options.uploadUrlTtlSeconds * 1000).toISOString();
    const meta: Record<string, string> = { application: "seekio" };
    if (input.filename) meta.filename = input.filename;
    try {
      const upload = await this.stream.createDirectUpload({
        maxDurationSeconds: input.maxDurationSeconds ?? this.options.maxVideoDurationSeconds,
        expiry: expiresAt,
        requireSignedURLs: true,
        scheduledDeletion: this.safetyNetDeletion(),
        meta,
      });
      try {
        return { videoId: upload.id, uploadUrl: upload.uploadURL, expiresAt };
      } finally {
        disposeStub(upload);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SeekioError("UPLOAD_CREATE_FAILED", `Could not create an upload URL: ${detail}`);
    }
  }

  async importFromUrl(input: ImportUrlInput): Promise<ImportedVideo> {
    const meta: Record<string, string> = { application: "seekio" };
    if (input.filename) meta.filename = input.filename;
    let id: string;
    let state: string;
    try {
      const video = await this.stream.upload(input.url, {
        requireSignedURLs: true,
        scheduledDeletion: this.safetyNetDeletion(),
        meta,
      });
      try {
        id = video.id;
        state = video.status.state;
      } finally {
        disposeStub(video);
      }
    } catch (error) {
      throw importError(error);
    }
    if (!isVideoStatus(state)) {
      throw new SeekioError(
        "BACKEND_ERROR",
        `Cloudflare Stream returned an unknown status "${state}".`,
      );
    }
    return { videoId: id, status: state };
  }

  async getInfo(videoId: string): Promise<VideoInfo> {
    const video = await this.details(videoId);
    const state = video.state;
    if (!isVideoStatus(state)) {
      throw new SeekioError(
        "BACKEND_ERROR",
        `Cloudflare Stream returned an unknown status "${state}".`,
      );
    }
    const ready = state === "ready" && video.readyToStream;
    const info: VideoInfo = { id: video.id, status: state };
    if (ready && video.duration > 0) info.duration = video.duration;
    if (video.width !== undefined && video.width > 0) info.width = video.width;
    if (video.height !== undefined && video.height > 0) info.height = video.height;
    if (video.created) info.createdAt = video.created;
    const pct = video.pctComplete === undefined ? Number.NaN : Number.parseFloat(video.pctComplete);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) info.pctComplete = pct;
    return info;
  }

  async getFrame(videoId: string, timestamp: number, options?: FrameOptions): Promise<Frame> {
    const source = await this.thumbnailSource(videoId);
    const height = options?.fullResolution ? source.fullHeight : source.height;
    const first = await this.fetchThumbnail(source, timestamp, height);
    if (first.ok) return first.frame;
    const nearEnd = source.duration - timestamp <= END_RETRY_WINDOW_SECONDS;
    if (nearEnd && first.status >= 400 && first.status < 500) {
      for (const earlier of retryTimestamps(timestamp)) {
        const retry = await this.fetchThumbnail(source, earlier, height);
        if (retry.ok) return retry.frame;
      }
    }
    throw new SeekioError(
      "FRAME_FETCH_FAILED",
      `Cloudflare Stream returned HTTP ${first.status} for the frame at ${timestamp}s.`,
    );
  }

  private async fetchThumbnail(
    source: ThumbnailSource,
    timestamp: number,
    height: number,
  ): Promise<{ ok: true; frame: Frame } | { ok: false; status: number }> {
    const url = new URL(`${source.base}/thumbnails/thumbnail.jpg`);
    url.searchParams.set("time", `${timestamp}s`);
    url.searchParams.set("height", String(height));
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
    if (!response.ok) return { ok: false, status: response.status };
    return {
      ok: true,
      frame: { timestamp, mimeType: "image/jpeg", data: await response.arrayBuffer() },
    };
  }

  /**
   * Lists videos whose `meta.application` is exactly "seekio". Stream returns newest first and has
   * no cursor, so pages are walked with `before` = oldest `created` seen, inclusive (`lte`) so a
   * timestamp tie at a page boundary is not skipped; ids already seen are ignored. It stops on a
   * short page, or when a page adds no new video (e.g. more than a page share one timestamp).
   */
  async listVideos(): Promise<ListedVideo[]> {
    const seen = new Set<string>();
    const found: ListedVideo[] = [];
    let before: string | undefined;
    try {
      for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const videos = await this.stream.videos.list({
          limit: LIST_PAGE_SIZE,
          ...(before !== undefined && { before, beforeComp: "lte" as const }),
        });
        let count = 0;
        let added = 0;
        let oldest: { time: number; raw: string } | undefined;
        try {
          for (const video of videos) {
            count++;
            const id = video.id;
            const created = video.created;
            const application = video.meta?.application;
            disposeStub(video);
            const time = Date.parse(created);
            if (Number.isFinite(time) && (!oldest || time < oldest.time)) {
              oldest = { time, raw: created };
            }
            if (seen.has(id)) continue;
            seen.add(id);
            added++;
            if (application === "seekio") found.push({ videoId: id, createdAt: created });
          }
        } finally {
          disposeStub(videos);
        }
        if (count < LIST_PAGE_SIZE || added === 0 || !oldest) break;
        before = oldest.raw;
      }
    } catch (error) {
      throw backendError(error, "list videos");
    }
    return found;
  }

  async delete(videoId: string): Promise<void> {
    try {
      await this.withVideo(videoId, (handle) => handle.delete());
    } catch (error) {
      if (isNotFound(error)) return;
      throw backendError(error, `delete video ${videoId}`);
    }
  }

  /** Borrows a video handle for one operation and always disposes it afterwards. */
  private async withVideo<T>(
    videoId: string,
    fn: (handle: StreamVideoHandle) => Promise<T>,
  ): Promise<T> {
    const handle = this.stream.video(videoId);
    try {
      return await fn(handle);
    } finally {
      disposeStub(handle);
    }
  }

  private async details(videoId: string): Promise<VideoDetails> {
    try {
      return await this.withVideo(videoId, async (handle) => {
        const video = await handle.details();
        try {
          return copyDetails(video);
        } finally {
          disposeStub(video);
        }
      });
    } catch (error) {
      if (isNotFound(error)) throw new SeekioError("VIDEO_NOT_FOUND", messages.notFound(videoId));
      throw backendError(error, `read video ${videoId}`);
    }
  }

  private thumbnailSource(videoId: string): Promise<ThumbnailSource> {
    let source = this.thumbnailSources.get(videoId);
    if (!source) {
      source = (async () => {
        const video = await this.details(videoId);
        const origin = new URL(video.thumbnail).origin;
        let token: string;
        try {
          token = await this.withVideo(videoId, (handle) => handle.generateToken());
        } catch (error) {
          throw backendError(error, `sign video ${videoId}`);
        }
        // Never upscale: cap at the source height (unknown -> configured frameHeight).
        const sourceHeight = video.height;
        const height =
          sourceHeight !== undefined && sourceHeight > 0
            ? Math.min(sourceHeight, this.options.frameHeight)
            : this.options.frameHeight;
        const fullHeight =
          sourceHeight !== undefined && sourceHeight > 0 ? sourceHeight : this.options.frameHeight;
        return { base: `${origin}/${token}`, height, fullHeight, duration: video.duration };
      })();
      this.thumbnailSources.set(videoId, source);
    }
    return source;
  }
}
