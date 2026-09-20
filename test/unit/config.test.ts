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
  });
});
