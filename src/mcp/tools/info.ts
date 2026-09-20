import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../log";
import { jsonContent, runTool, type ToolDeps } from "../server";

export const videoIdSchema = z
  .string()
  .min(1)
  .describe("Video id returned by video_create_upload.");

export function registerInfo(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "video_info",
    {
      title: "Video info",
      description:
        "Get encoding status, duration, and dimensions of a video. Call this first; frame tools only work when ready is true. If the video is still processing, wait and call again.",
      inputSchema: z.object({ video_id: videoIdSchema }),
    },
    async ({ video_id }) =>
      runTool("video_info", async () => {
        const started = Date.now();
        const info = await deps.backend.getInfo(video_id);
        log("video.info", { video_id, status: info.status, duration_ms: Date.now() - started });
        return {
          content: [
            jsonContent({
              id: info.id,
              status: info.status,
              duration: info.duration,
              width: info.width,
              height: info.height,
              ready: info.status === "ready" && info.duration !== undefined,
            }),
          ],
        };
      }),
  );
}
