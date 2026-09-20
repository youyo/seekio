import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../log";
import { jsonContent, runTool, type ToolDeps } from "../server";
import { videoIdSchema } from "./info";

export function registerDelete(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "video_delete",
    {
      title: "Delete video",
      description:
        "Delete a video and its frames from storage. Safe to call more than once. Call it when the investigation is finished.",
      inputSchema: z.object({ video_id: videoIdSchema }),
    },
    async ({ video_id }) =>
      runTool("video_delete", async () => {
        const started = Date.now();
        await deps.backend.delete(video_id);
        log("video.deleted", { video_id, duration_ms: Date.now() - started });
        return { content: [jsonContent({ video_id, deleted: true })] };
      }),
  );
}
