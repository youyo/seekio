import type { Env } from "./env";

export const defaults = {
  maxVideoDurationSeconds: 300,
  uploadUrlTtlSeconds: 900,
  maxUploadBytes: 209_715_200,
  maxFramesPerCall: 15,
  defaultFramesFps: 5,
  maxFps: 30,
  overviewMaxFrames: 12,
  frameHeight: 720,
  regionMaxLongEdge: 1568,
  frameFetchConcurrency: 6,
  infoMaxWaitSeconds: 25,
  infoPollIntervalMs: 2000,
  videoRetentionHours: 24,
  /** Extra thumbnail attempts on HTTP 404 for video_frame (backoff base, 2x, 4x). */
  frameRetrySingleMax: 3,
  /** Extra thumbnail attempts per frame on HTTP 404 for video_frames / video_overview. */
  frameRetryMultiMax: 1,
  /** First 404 backoff; doubles on each further retry (1s, 2s, 4s). */
  frameRetryBaseDelayMs: 1000,
} as const;

export type SeekioConfig = { -readonly [K in keyof typeof defaults]: number };

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** Resolves runtime configuration from Worker vars, falling back to `defaults` for missing or invalid values. */
export function resolveConfig(
  env: Pick<Env, "MAX_VIDEO_DURATION_SECONDS" | "UPLOAD_URL_TTL_SECONDS" | "VIDEO_RETENTION_HOURS">,
): SeekioConfig {
  return {
    ...defaults,
    maxVideoDurationSeconds: positiveInteger(
      env.MAX_VIDEO_DURATION_SECONDS,
      defaults.maxVideoDurationSeconds,
    ),
    uploadUrlTtlSeconds: positiveInteger(env.UPLOAD_URL_TTL_SECONDS, defaults.uploadUrlTtlSeconds),
    videoRetentionHours: positiveInteger(env.VIDEO_RETENTION_HOURS, defaults.videoRetentionHours),
  };
}
