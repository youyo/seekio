import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../log";
import { jsonContent, runTool, type ToolDeps } from "../server";

const httpUrl = z
  .url({ protocol: /^https?$/ })
  .describe("Public http(s) URL of a video file that can be downloaded directly.");

export function registerImportUrl(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "video_import_url",
    {
      title: "Import video from URL",
      description: `Import a video from a public http(s) URL that serves a video file directly (for example https://example.com/foo.mp4). Web pages such as YouTube are not supported. Cloudflare Stream downloads the file asynchronously: this returns video_id and status immediately, then poll video_info until status is ready. The duration limit (${deps.config.maxVideoDurationSeconds} seconds) is checked only after processing, when frames are requested; longer videos are rejected with VIDEO_TOO_LONG and should be removed with video_delete. Videos are stored temporarily; delete them with video_delete when done.`,
      inputSchema: z.object({
        url: httpUrl,
        filename: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Original filename, kept as metadata."),
      }),
    },
    async ({ url, filename }) =>
      runTool("video_import_url", async () => {
        const started = Date.now();
        const imported = await deps.backend.importFromUrl({
          url,
          ...(filename !== undefined && { filename }),
        });
        // The URL may carry signed query parameters, so it is never logged.
        log("upload.imported", { video_id: imported.videoId, duration_ms: Date.now() - started });
        return {
          content: [jsonContent({ video_id: imported.videoId, status: imported.status })],
        };
      }),
  );
}
