import { SeekioError } from "../../src/mcp/errors";
import type { Frame } from "../../src/video/backend";
import type { CroppedImage, ImageCropper } from "../../src/video/image";
import { fitLongEdge, type Region, regionToPixels } from "../../src/video/region";

/** Marker payload returned by the fake cropper (distinct from FAKE_JPEG). */
export const FAKE_CROP_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);

export type CropCall = { frame: Frame; region: Region; maxLongEdge: number };

/** In-memory ImageCropper. Pretends every frame is `sourceWidth` x `sourceHeight`. */
export class FakeImageCropper implements ImageCropper {
  readonly calls: CropCall[] = [];
  /** When set, `crop` throws it. */
  error: Error | undefined;
  sourceWidth = 1920;
  sourceHeight = 1080;

  async crop(frame: Frame, region: Region, maxLongEdge: number): Promise<CroppedImage> {
    this.calls.push({ frame, region, maxLongEdge });
    if (this.error) throw this.error;
    const px = regionToPixels(region, this.sourceWidth, this.sourceHeight);
    const fit = fitLongEdge(px.width, px.height, maxLongEdge);
    return {
      mimeType: "image/jpeg",
      data: FAKE_CROP_JPEG.slice().buffer,
      width: fit.width,
      height: fit.height,
    };
  }
}

export function cropFailed(): SeekioError {
  return new SeekioError("REGION_CROP_FAILED", "crop failed");
}
