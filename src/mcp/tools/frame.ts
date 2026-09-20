import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../log";
import { frameTextContent, frameToImageContent } from "../../video/frame";
import { validateFrameAt } from "../../video/timestamps";
import { requireReady, runTool, type ToolDeps } from "../server";
import { videoIdSchema } from "./info";

export function registerFrame(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "video_frame",
    {
      title: "Exact video frame",
      description:
        "Get the single frame at an exact timestamp (sub-second precision) as an image. Use it for precise inspection after narrowing the range with video_overview and video_frames.",
      inputSchema: z.object({
        video_id: videoIdSchema,
        at: z.number().min(0).describe("Timestamp in seconds, 0 <= at < duration."),
      }),
    },
    async ({ video_id, at }) =>
      runTool("video_frame", async () => {
        const started = Date.now();
        const info = await requireReady(deps, video_id);
        const timestamp = validateFrameAt(at, info.duration);
        const frame = await deps.backend.getFrame(video_id, timestamp);
        log("frame.requested", { video_id, at: timestamp, duration_ms: Date.now() - started });
        return { content: [frameTextContent(frame.timestamp), frameToImageContent(frame)] };
      }),
  );
}
