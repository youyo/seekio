import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../log";
import { SeekioError } from "../errors";
import { jsonContent, runTool, type ToolDeps } from "../server";

export function registerCreateUpload(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "video_create_upload",
    {
      title: "Create video upload",
      description:
        "Create a one-time direct upload URL for a video. Upload the file bytes to upload_url with an HTTP POST multipart/form-data request (field name: file) before it expires, then poll video_info until status is ready. Videos are stored temporarily; delete them with video_delete when done.",
      inputSchema: z.object({
        filename: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Original filename, kept as metadata."),
        max_duration_seconds: z
          .number()
          .positive()
          .optional()
          .describe("Reject uploads longer than this many seconds. Defaults to the server limit."),
      }),
    },
    async ({ filename, max_duration_seconds }) =>
      runTool("video_create_upload", async () => {
        const limit = deps.config.maxVideoDurationSeconds;
        if (max_duration_seconds !== undefined && max_duration_seconds > limit) {
          throw new SeekioError(
            "INVALID_INTERVAL",
            `max_duration_seconds (${max_duration_seconds}) exceeds the server limit of ${limit} seconds.`,
          );
        }
        const started = Date.now();
        const upload = await deps.backend.createUpload({
          ...(filename !== undefined && { filename }),
          maxDurationSeconds: max_duration_seconds ?? limit,
        });
        log("upload.created", { video_id: upload.videoId, duration_ms: Date.now() - started });
        return {
          content: [
            jsonContent({
              video_id: upload.videoId,
              upload_url: upload.uploadUrl,
              expires_at: upload.expiresAt,
              max_duration_seconds: max_duration_seconds ?? limit,
              max_upload_bytes: deps.config.maxUploadBytes,
            }),
          ],
        };
      }),
  );
}
