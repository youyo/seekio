import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../log";
import { SeekioError } from "../errors";
import { jsonContent, runTool, type ToolDeps } from "../server";

/** Single-quotes a value for POSIX shells. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function registerCreateUpload(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "video_create_upload",
    {
      title: "Create video upload",
      description: `Create a one-time direct upload URL for a video. The server cannot read your local files, so the upload is a separate step: replace <PATH> in the returned upload_command with the local file path and run it in a shell (inside <PATH>, escape every " and \\ with a backslash, and do not use a single quote ' in the path; curl 7.76 or newer is required for --fail-with-body; it POSTs the file as multipart/form-data, field name: file, to upload_url) before expires_at, then call video_info with wait_seconds (up to ${deps.config.infoMaxWaitSeconds}) to wait until the video is ready. Videos are stored temporarily in the Cloudflare account and are deleted automatically about ${deps.config.videoRetentionHours} hours after creation (the cleanup runs hourly, so up to about an hour later); call video_delete as soon as you are done to remove them immediately.`,
      inputSchema: z.object({
        filename: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Original filename, kept as metadata."),
        max_duration_seconds: z
          .number()
          .int()
          .min(1)
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
              upload_command: `curl -sS --fail-with-body -X POST -F 'file=@"<PATH>"' ${shellQuote(upload.uploadUrl)}`,
              expires_at: upload.expiresAt,
              max_duration_seconds: max_duration_seconds ?? limit,
              max_upload_bytes: deps.config.maxUploadBytes,
              auto_delete_after_hours: deps.config.videoRetentionHours,
            }),
          ],
        };
      }),
  );
}
