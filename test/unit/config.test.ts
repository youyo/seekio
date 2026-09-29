import { describe, expect, it } from "vitest";
import { defaults, resolveConfig } from "../../src/config";

describe("resolveConfig", () => {
  it("returns defaults when no vars are set", () => {
    expect(resolveConfig({})).toEqual(defaults);
  });

  it("overrides numeric vars from strings and ignores invalid values", () => {
    const config = resolveConfig({
      MAX_VIDEO_DURATION_SECONDS: "600",
      UPLOAD_URL_TTL_SECONDS: "not-a-number",
    });
    expect(config.maxVideoDurationSeconds).toBe(600);
    expect(config.uploadUrlTtlSeconds).toBe(defaults.uploadUrlTtlSeconds);
    expect(resolveConfig({ MAX_VIDEO_DURATION_SECONDS: "0" }).maxVideoDurationSeconds).toBe(300);
    expect(resolveConfig({ MAX_VIDEO_DURATION_SECONDS: "1.5" }).maxVideoDurationSeconds).toBe(300);
  });

  it("defaults videoRetentionHours to 24 and overrides it from VIDEO_RETENTION_HOURS", () => {
    expect(resolveConfig({}).videoRetentionHours).toBe(24);
    expect(resolveConfig({ VIDEO_RETENTION_HOURS: "6" }).videoRetentionHours).toBe(6);
  });

  it.each(["0", "-1", "1.5", "abc", ""])(
    "falls back to the default retention for invalid VIDEO_RETENTION_HOURS %j",
    (raw) => {
      expect(resolveConfig({ VIDEO_RETENTION_HOURS: raw }).videoRetentionHours).toBe(24);
    },
  );
});

describe("frame retry defaults", () => {
  it("keeps the 404 retry counts small enough for the Workers subrequest limit", () => {
    expect(defaults.frameRetrySingleMax).toBe(3);
    expect(defaults.frameRetryMultiMax).toBe(1);
    expect(defaults.frameRetryBaseDelayMs).toBe(1000);
    // 15 frames x (1 + multi retries) thumbnail requests stays under the free plan's 50.
    expect(defaults.maxFramesPerCall * (1 + defaults.frameRetryMultiMax)).toBeLessThanOrEqual(50);
  });
});
