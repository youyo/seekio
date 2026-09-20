import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../log";
import { fetchFramesBounded, frameTextContent, frameToImageContent } from "../../video/frame";
import { frameTimestamps } from "../../video/timestamps";
import { requireReady, runTool, type ToolDeps } from "../server";
import { videoIdSchema } from "./info";

export function registerFrames(server: McpServer, deps: ToolDeps): void {
  const { maxFps, maxFramesPerCall, defaultFramesFps } = deps.config;
  server.registerTool(
    "video_frames",
    {
      title: "Video frames in range",
      description: `Inspect a time range at higher temporal resolution: returns frames from start to end at fps as timestamped images. At most ${maxFramesPerCall} frames per call and ${maxFps} fps; narrow the range or lower fps instead of scanning the whole video. Use video_frame for one exact timestamp.`,
      inputSchema: z.object({
        video_id: videoIdSchema,
        start: z.number().min(0).describe("Range start in seconds (inclusive)."),
        end: z.number().positive().describe("Range end in seconds (inclusive, must exceed start)."),
        fps: z
          .number()
          .positive()
          .optional()
          .describe(`Frames per second (default ${defaultFramesFps}, max ${maxFps}).`),
      }),
    },
    async ({ video_id, start, end, fps }) =>
      runTool("video_frames", async () => {
        const started = Date.now();
        const info = await requireReady(deps, video_id);
        const effectiveFps = fps ?? defaultFramesFps;
        const timestamps = frameTimestamps(
          { start, end, fps: effectiveFps, duration: info.duration },
          { maxFps, maxFramesPerCall },
        );
        const frames = await fetchFramesBounded(
          deps.backend,
          video_id,
          timestamps,
          deps.config.frameFetchConcurrency,
        );
        log("frames.requested", {
          video_id,
          start,
          end,
          fps: effectiveFps,
          frames: frames.length,
          duration_ms: Date.now() - started,
        });
        return {
          content: [
            {
              type: "text",
              text: `${frames.length} frames of video ${video_id} from ${start}s to ${end}s at ${effectiveFps} fps`,
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
