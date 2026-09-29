import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../log";
import type { Frame } from "../../video/backend";
import { frameTextContent, frameToImageContent } from "../../video/frame";
import { formatRegion, type Region, validateRegion } from "../../video/region";
import { validateFrameAt } from "../../video/timestamps";
import { isSeekioError, messages, SeekioError } from "../errors";
import { requireReady, runTool, type ToolDeps } from "../server";
import { videoIdSchema } from "./info";

const regionSchema = z
  .object({
    x: z.number().describe("Left edge as a ratio of the frame width (0 = left edge)."),
    y: z.number().describe("Top edge as a ratio of the frame height (0 = top edge)."),
    width: z.number().describe("Width as a ratio of the frame width, > 0."),
    height: z.number().describe("Height as a ratio of the frame height, > 0."),
  })
  .describe(
    "Optional crop, as ratios (0-1) of the frame with the origin at the top-left: x = left edge, y = top edge, x + width <= 1, y + height <= 1. Example: the bottom credits are { x: 0, y: 0.8, width: 1, height: 0.2 }.",
  )
  .optional();

export function registerFrame(server: McpServer, deps: ToolDeps): void {
  const maxLongEdge = deps.config.regionMaxLongEdge;
  server.registerTool(
    "video_frame",
    {
      title: "Exact video frame",
      description: `Get the single frame at an exact timestamp (sub-second precision) as an image. Use it for precise inspection after narrowing the range with video_overview and video_frames. Whole frames are downscaled (about ${deps.config.frameHeight}px tall), so small text such as credits or captions may be unreadable: to read fine details, pass region to crop that area out of the original-resolution frame (long edge at most ${maxLongEdge}px). region is { x, y, width, height } as ratios (0-1) of the frame with the origin at the top-left (x = left edge, y = top edge). Example: bottom credits = { x: 0, y: 0.8, width: 1, height: 0.2 }.`,
      inputSchema: z.object({
        video_id: videoIdSchema,
        at: z.number().min(0).describe("Timestamp in seconds, 0 <= at < duration."),
        region: regionSchema,
      }),
    },
    async ({ video_id, at, region }) =>
      runTool("video_frame", async () => {
        const started = Date.now();
        const info = await requireReady(deps, video_id);
        const timestamp = validateFrameAt(at, info.duration);
        if (region === undefined) {
          const frame = await deps.backend.getFrame(video_id, timestamp, {
            maxNotFoundRetries: deps.config.frameRetrySingleMax,
          });
          log("frame.requested", {
            video_id,
            at: timestamp,
            region: false,
            duration_ms: Date.now() - started,
          });
          return { content: [frameTextContent(frame.timestamp), frameToImageContent(frame)] };
        }
        validateRegion(region);
        if (!deps.cropper) throw new SeekioError("REGION_UNAVAILABLE", messages.regionUnavailable);
        const source = await deps.backend.getFrame(video_id, timestamp, {
          fullResolution: true,
          maxNotFoundRetries: deps.config.frameRetrySingleMax,
        });
        const cropped = await deps.cropper
          .crop(source, region as Region, maxLongEdge)
          .catch((e) => {
            throw isSeekioError(e)
              ? e
              : new SeekioError("REGION_CROP_FAILED", messages.regionCropFailed());
          });
        const frame: Frame = {
          timestamp: source.timestamp,
          mimeType: cropped.mimeType,
          data: cropped.data,
        };
        log("frame.requested", {
          video_id,
          at: timestamp,
          region: true,
          out_width: cropped.width,
          out_height: cropped.height,
          duration_ms: Date.now() - started,
        });
        return {
          content: [
            {
              type: "text",
              text: `Frame at ${frame.timestamp}s, region ${formatRegion(region)} (${cropped.width}x${cropped.height} px)`,
            },
            frameToImageContent(frame),
          ],
        };
      }),
  );
}
