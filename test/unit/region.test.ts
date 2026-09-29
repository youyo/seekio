import { describe, expect, it } from "vitest";
import { SeekioError } from "../../src/mcp/errors";
import { fitLongEdge, formatRegion, regionToPixels, validateRegion } from "../../src/video/region";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof SeekioError) return error.code;
    throw error;
  }
  return undefined;
}

describe("validateRegion", () => {
  it("accepts the whole frame and interior boxes", () => {
    expect(validateRegion({ x: 0, y: 0, width: 1, height: 1 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(codeOf(() => validateRegion({ x: 0, y: 0.8, width: 1, height: 0.2 }))).toBeUndefined();
    expect(
      codeOf(() => validateRegion({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })),
    ).toBeUndefined();
  });

  it("absorbs floating point error at the far edge", () => {
    // 0.1 + 0.9 = 1 exactly, but 0.7 + 0.3 and 0.6 + 0.4 style sums can overshoot by ~1e-16.
    expect(
      codeOf(() => validateRegion({ x: 0.7, y: 0.6, width: 0.3, height: 0.4 })),
    ).toBeUndefined();
    expect(
      codeOf(() => validateRegion({ x: 0.1 + 0.2, y: 0, width: 0.7, height: 1 })),
    ).toBeUndefined();
  });

  it.each([
    ["negative x", { x: -0.1, y: 0, width: 0.5, height: 0.5 }],
    ["negative y", { x: 0, y: -0.1, width: 0.5, height: 0.5 }],
    ["x above 1", { x: 1.1, y: 0, width: 0.5, height: 0.5 }],
    ["y above 1", { x: 0, y: 1.1, width: 0.5, height: 0.5 }],
    ["zero width", { x: 0, y: 0, width: 0, height: 0.5 }],
    ["zero height", { x: 0, y: 0, width: 0.5, height: 0 }],
    ["width above 1", { x: 0, y: 0, width: 1.5, height: 0.5 }],
    ["height above 1", { x: 0, y: 0, width: 0.5, height: 1.5 }],
    ["x + width overflow", { x: 0.6, y: 0, width: 0.5, height: 0.5 }],
    ["y + height overflow", { x: 0, y: 0.9, width: 0.5, height: 0.2 }],
    ["overflow just beyond tolerance", { x: 0.5, y: 0, width: 0.5 + 1e-3, height: 1 }],
  ])("rejects %s with INVALID_REGION", (_name, region) => {
    expect(codeOf(() => validateRegion(region))).toBe("INVALID_REGION");
  });

  it("explains the correct usage in the message", () => {
    try {
      validateRegion({ x: 0.6, y: 0, width: 0.5, height: 0.5 });
      expect.unreachable();
    } catch (error) {
      const message = (error as SeekioError).message;
      expect(message).toContain("top-left");
      expect(message).toContain("0.8");
    }
  });
});

describe("regionToPixels", () => {
  it("converts ratios to integer pixels", () => {
    expect(regionToPixels({ x: 0, y: 0.8, width: 1, height: 0.2 }, 1920, 1080)).toEqual({
      left: 0,
      top: 864,
      width: 1920,
      height: 216,
    });
    expect(regionToPixels({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, 1000, 800)).toEqual({
      left: 250,
      top: 400,
      width: 500,
      height: 200,
    });
  });

  it("never exceeds the frame and is at least 1px", () => {
    const px = regionToPixels({ x: 0.9999, y: 0.9999, width: 0.0001, height: 0.0001 }, 100, 100);
    expect(px.width).toBeGreaterThanOrEqual(1);
    expect(px.height).toBeGreaterThanOrEqual(1);
    expect(px.left + px.width).toBeLessThanOrEqual(100);
    expect(px.top + px.height).toBeLessThanOrEqual(100);
    const full = regionToPixels({ x: 0, y: 0, width: 1, height: 1 }, 333, 777);
    expect(full).toEqual({ left: 0, top: 0, width: 333, height: 777 });
  });
});

describe("fitLongEdge", () => {
  it("leaves images within the limit unchanged (never enlarges)", () => {
    expect(fitLongEdge(1920, 216, 1568)).toEqual({ width: 1568, height: 176, scaled: true });
    expect(fitLongEdge(800, 600, 1568)).toEqual({ width: 800, height: 600, scaled: false });
    expect(fitLongEdge(1568, 1000, 1568)).toEqual({ width: 1568, height: 1000, scaled: false });
  });

  it("scales by the long edge whichever it is", () => {
    expect(fitLongEdge(1080, 1920, 1568)).toEqual({ width: 882, height: 1568, scaled: true });
  });

  it("keeps at least 1px on the short edge", () => {
    expect(fitLongEdge(10000, 1, 1568)).toEqual({ width: 1568, height: 1, scaled: true });
  });
});

describe("formatRegion", () => {
  it("prints x/y/w/h compactly", () => {
    expect(formatRegion({ x: 0, y: 0.8, width: 1, height: 0.2 })).toBe("x=0 y=0.8 w=1 h=0.2");
  });
});
