import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../log";
import { fetchFramesBounded, frameTextContent, frameToImageContent } from "../../video/frame";
import { overviewTimestamps } from "../../video/timestamps";
import { requireReady, runTool, type ToolDeps } from "../server";
import { videoIdSchema } from "./info";

export function registerOverview(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "video_overview",
    {
      title: "Video overview",
      description:
        "Inspect the whole timeline at low temporal resolution: returns up to max_frames evenly spaced frames as timestamped images. Use it first to locate suspicious time ranges, then zoom in with video_frames.",
      inputSchema: z.object({
        video_id: videoIdSchema,
        max_frames: z
          .number()
          .int()
          .min(1)
          .max(deps.config.maxFramesPerCall)
          .optional()
          .describe(`Maximum number of frames (default ${deps.config.overviewMaxFrames}).`),
        interval_seconds: z
          .number()
          .positive()
          .optional()
          .describe("Fixed spacing between frames in seconds. Omit to spread max_frames evenly."),
      }),
    },
    async ({ video_id, max_frames, interval_seconds }) =>
      runTool("video_overview", async () => {
        const started = Date.now();
        const info = await requireReady(deps, video_id);
        const timestamps = overviewTimestamps(info.duration, {
          maxFrames: max_frames ?? deps.config.overviewMaxFrames,
          ...(interval_seconds !== undefined && { intervalSeconds: interval_seconds }),
        });
        const frames = await fetchFramesBounded(
          deps.backend,
          video_id,
          timestamps,
          deps.config.frameFetchConcurrency,
        );
        log("overview.requested", {
          video_id,
          frames: frames.length,
          duration: info.duration,
          duration_ms: Date.now() - started,
        });
        return {
          content: [
            {
              type: "text",
              text: `Overview of video ${video_id} (${info.duration}s): ${frames.length} frames at ${timestamps.map((t) => `${t}s`).join(", ")}`,
            },
            ...frames.flatMap((frame) => [
              frameTextContent(frame.timestamp),
              frameToImageContent(frame),
            ]),
          ],
        };
      }),
  );
}
