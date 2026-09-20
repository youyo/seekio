import type { Env } from "./env";

export const defaults = {
  maxVideoDurationSeconds: 300,
  uploadUrlTtlSeconds: 900,
  maxUploadBytes: 209_715_200,
  maxFramesPerCall: 30,
  defaultFramesFps: 5,
  maxFps: 30,
  overviewMaxFrames: 12,
  frameHeight: 1080,
  frameFetchConcurrency: 6,
} as const;

export type SeekioConfig = { -readonly [K in keyof typeof defaults]: number };

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolves runtime configuration from Worker vars, falling back to `defaults` for missing or invalid values. */
export function resolveConfig(
  env: Pick<Env, "MAX_VIDEO_DURATION_SECONDS" | "UPLOAD_URL_TTL_SECONDS">,
): SeekioConfig {
  return {
    ...defaults,
    maxVideoDurationSeconds: positiveNumber(
      env.MAX_VIDEO_DURATION_SECONDS,
      defaults.maxVideoDurationSeconds,
    ),
    uploadUrlTtlSeconds: positiveNumber(env.UPLOAD_URL_TTL_SECONDS, defaults.uploadUrlTtlSeconds),
  };
}
