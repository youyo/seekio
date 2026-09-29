import { messages, SeekioError } from "../mcp/errors";
import type { Frame } from "./backend";
import { fitLongEdge, type Region, regionToPixels } from "./region";

export type CroppedImage = {
  mimeType: "image/jpeg";
  data: ArrayBuffer;
  /** Output size in pixels. */
  width: number;
  height: number;
};

/**
 * The seam for cutting a region out of a frame. Kept outside `VideoBackend`: Stream thumbnails
 * cannot crop arbitrary rectangles, so this is a separate provider (Cloudflare Images).
 */
export interface ImageCropper {
  /** Crops `region` (ratios) out of `frame`; the long edge of the result is at most `maxLongEdge`. */
  crop(frame: Frame, region: Region, maxLongEdge: number): Promise<CroppedImage>;
}

const JPEG_QUALITY = 90;

function failed(error: unknown): SeekioError {
  if (error instanceof SeekioError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  return new SeekioError(
    "REGION_CROP_FAILED",
    messages.regionCropFailed(typeof code === "number" ? code : undefined),
  );
}

const streamOf = (data: ArrayBuffer): ReadableStream<Uint8Array> =>
  new Response(data).body as ReadableStream<Uint8Array>;

/** `ImageCropper` backed by the Cloudflare Images Workers binding (`env.IMAGES`). */
export class ImagesBindingCropper implements ImageCropper {
  private readonly images: ImagesBinding;

  constructor(images: ImagesBinding) {
    this.images = images;
  }

  /** Actual output size via the (free) `info()`; falls back to the computed size if it is unavailable. */
  private async outputSize(
    data: ArrayBuffer,
    computed: { width: number; height: number },
  ): Promise<{ width: number; height: number }> {
    try {
      const out = await this.images.info(streamOf(data));
      if ("width" in out && out.width > 0 && out.height > 0) {
        return { width: out.width, height: out.height };
      }
    } catch {
      // Best effort: the caption falls back to the computed size.
    }
    return { width: computed.width, height: computed.height };
  }

  async crop(frame: Frame, region: Region, maxLongEdge: number): Promise<CroppedImage> {
    try {
      const info = await this.images.info(streamOf(frame.data));
      if (!("width" in info)) throw new Error("unsupported image");
      const rect = regionToPixels(region, info.width, info.height);
      const fit = fitLongEdge(rect.width, rect.height, maxLongEdge);
      // trim runs before resize; scale-down guarantees the frame is never enlarged.
      const result = await this.images
        .input(streamOf(frame.data))
        .transform({
          // Pixels removed from each side: the only unambiguous form of trim.
          trim: {
            left: rect.left,
            top: rect.top,
            right: info.width - (rect.left + rect.width),
            bottom: info.height - (rect.top + rect.height),
          },
          ...(fit.scaled && { width: fit.width, height: fit.height, fit: "scale-down" as const }),
        })
        .output({ format: "image/jpeg", quality: JPEG_QUALITY });
      const data = await new Response(result.image()).arrayBuffer();
      const size = await this.outputSize(data, fit);
      return { mimeType: "image/jpeg", data, ...size };
    } catch (error) {
      throw failed(error);
    }
  }
}

/** Builds a cropper from `env.IMAGES`; without the binding, region is unavailable. */
export function createImageCropper(images: ImagesBinding | undefined): ImageCropper | undefined {
  return images ? new ImagesBindingCropper(images) : undefined;
}
