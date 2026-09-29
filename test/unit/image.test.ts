import { describe, expect, it, vi } from "vitest";
import { createImageCropper, ImagesBindingCropper } from "../../src/video/image";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const OUT = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);

function fakeImages(
  source: { width: number; height: number },
  options: {
    infoError?: Error;
    outputError?: Error;
    /** What info() reports for the transformed image (2nd call). Default: `{}` -> no width. */
    outputInfo?: Record<string, unknown>;
  } = {},
) {
  const transforms: unknown[] = [];
  const outputs: unknown[] = [];
  let infoCalls = 0;
  const info = vi.fn(async (_stream: ReadableStream<Uint8Array>) => {
    if (options.infoError) throw options.infoError;
    infoCalls++;
    if (infoCalls === 1) return { format: "image/jpeg", fileSize: JPEG.length, ...source };
    return options.outputInfo ?? { format: "image/jpeg", fileSize: OUT.length };
  });
  const binding = {
    info,
    input: (_stream: ReadableStream<Uint8Array>) => {
      const transformer = {
        transform: (t: unknown) => {
          transforms.push(t);
          return transformer;
        },
        output: async (o: unknown) => {
          outputs.push(o);
          if (options.outputError) throw options.outputError;
          return {
            contentType: () => "image/jpeg",
            image: () => new Response(OUT).body as ReadableStream<Uint8Array>,
          };
        },
      };
      return transformer;
    },
  } as unknown as ImagesBinding;
  return { binding, transforms, outputs, info };
}

const frame = { timestamp: 1, mimeType: "image/jpeg" as const, data: JPEG.slice().buffer };

describe("ImagesBindingCropper", () => {
  it("passes a pixel trim and jpeg output, without resizing when within the limit", async () => {
    const { binding, transforms, outputs } = fakeImages(
      { width: 1000, height: 800 },
      { outputInfo: { format: "image/jpeg", fileSize: 6, width: 500, height: 200 } },
    );
    const result = await new ImagesBindingCropper(binding).crop(
      frame,
      { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
      1568,
    );
    expect(transforms).toEqual([{ trim: { left: 250, top: 400, right: 250, bottom: 200 } }]);
    expect(outputs).toEqual([{ format: "image/jpeg", quality: 90 }]);
    expect(result.width).toBe(500);
    expect(result.height).toBe(200);
    expect(result.mimeType).toBe("image/jpeg");
    expect(new Uint8Array(result.data)).toEqual(OUT);
  });

  it("downsizes to the long-edge limit with scale-down (never enlarges)", async () => {
    const { binding, transforms } = fakeImages(
      { width: 1920, height: 1080 },
      { outputInfo: { format: "image/jpeg", fileSize: 6, width: 1568, height: 176 } },
    );
    const result = await new ImagesBindingCropper(binding).crop(
      frame,
      { x: 0, y: 0.8, width: 1, height: 0.2 },
      1568,
    );
    expect(transforms).toEqual([
      {
        trim: { left: 0, top: 864, right: 0, bottom: 0 },
        width: 1568,
        height: 176,
        fit: "scale-down",
      },
    ]);
    expect(result.width).toBe(1568);
    expect(result.height).toBe(176);
  });

  it("reports the actual output size from info(), not the computed one", async () => {
    const { binding, info } = fakeImages(
      { width: 1920, height: 1080 },
      { outputInfo: { format: "image/jpeg", fileSize: 6, width: 1567, height: 175 } },
    );
    const result = await new ImagesBindingCropper(binding).crop(
      frame,
      { x: 0, y: 0.8, width: 1, height: 0.2 },
      1568,
    );
    expect(info).toHaveBeenCalledTimes(2);
    expect([result.width, result.height]).toEqual([1567, 175]);
  });

  it("falls back to the computed size when info() reports no width or fails", async () => {
    const noWidth = fakeImages({ width: 1920, height: 1080 });
    const a = await new ImagesBindingCropper(noWidth.binding).crop(
      frame,
      { x: 0, y: 0.8, width: 1, height: 0.2 },
      1568,
    );
    expect([a.width, a.height]).toEqual([1568, 176]);
    const failing = fakeImages({ width: 1920, height: 1080 });
    failing.info.mockImplementationOnce(async () => ({
      format: "image/jpeg",
      fileSize: 1,
      width: 1920,
      height: 1080,
    }));
    failing.info.mockImplementationOnce(async () => {
      throw new Error("info failed");
    });
    const b = await new ImagesBindingCropper(failing.binding).crop(
      frame,
      { x: 0, y: 0.8, width: 1, height: 0.2 },
      1568,
    );
    expect([b.width, b.height]).toEqual([1568, 176]);
  });

  it("computes right/bottom correctly when left and top are non-zero", async () => {
    const { binding, transforms } = fakeImages({ width: 1000, height: 800 });
    await new ImagesBindingCropper(binding).crop(
      frame,
      { x: 0.1, y: 0.25, width: 0.5, height: 0.5 },
      1568,
    );
    // left 100, top 200, width 500, height 400 -> right = 1000-600, bottom = 800-600
    expect(transforms).toEqual([{ trim: { left: 100, top: 200, right: 400, bottom: 200 } }]);
  });

  it("maps a failing info() to REGION_CROP_FAILED", async () => {
    const { binding } = fakeImages(
      { width: 1, height: 1 },
      { infoError: Object.assign(new Error("bad"), { code: 9412 }) },
    );
    await expect(
      new ImagesBindingCropper(binding).crop(frame, { x: 0, y: 0, width: 1, height: 1 }, 1568),
    ).rejects.toMatchObject({ code: "REGION_CROP_FAILED" });
  });

  it("maps a failing transform to REGION_CROP_FAILED without leaking the provider message", async () => {
    const { binding } = fakeImages(
      { width: 100, height: 100 },
      { outputError: Object.assign(new Error("secret provider detail"), { code: 9422 }) },
    );
    const error = await new ImagesBindingCropper(binding)
      .crop(frame, { x: 0, y: 0, width: 1, height: 1 }, 1568)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "REGION_CROP_FAILED" });
    expect((error as Error).message).toContain("region");
    expect((error as Error).message).not.toContain("secret provider detail");
  });
});

describe("createImageCropper", () => {
  it("returns undefined without a binding and a cropper with one", () => {
    expect(createImageCropper(undefined)).toBeUndefined();
    expect(createImageCropper(fakeImages({ width: 1, height: 1 }).binding)).toBeDefined();
  });
});
