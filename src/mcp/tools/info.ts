import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../log";
import type { VideoInfo } from "../../video/backend";
import { jsonContent, runTool, type ToolDeps } from "../server";

export const videoIdSchema = z
  .string()
  .min(1)
  .describe("Video id returned by video_create_upload.");

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** ISO time at which the cleanup will consider the video expired, or undefined without a usable createdAt. */
function deleteAfter(createdAt: string | undefined, retentionHours: number): string | undefined {
  if (createdAt === undefined) return undefined;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return undefined;
  return new Date(created + retentionHours * 3_600_000).toISOString();
}

const isSettled = (info: VideoInfo) =>
  info.status === "error" || (info.status === "ready" && info.duration !== undefined);

export function registerInfo(server: McpServer, deps: ToolDeps): void {
  const sleep = deps.sleep ?? defaultSleep;
  const maxWait = deps.config.infoMaxWaitSeconds;
  const pollMs = deps.config.infoPollIntervalMs;
  server.registerTool(
    "video_info",
    {
      title: "Video info",
      description: `Get encoding status, duration, dimensions, encoding progress (pct_complete), and delete_after (when the video will be deleted automatically, about ${deps.config.videoRetentionHours} hours after creation; the cleanup runs hourly, so up to about an hour later; call video_delete when done to remove it immediately) of a video. Frame tools only work when ready is true (the video can be played and thumbnails can be taken). pct_complete is the progress of encoding every quality level and can still be below 100 when ready is already true; do not wait for it to reach 100. If the video is still processing, pass wait_seconds (up to ${maxWait}) to wait for it to finish in a single call instead of calling repeatedly; it returns as soon as the video is ready or has failed, or the current status when the time is up.`,
      inputSchema: z.object({
        video_id: videoIdSchema,
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(maxWait)
          .optional()
          .describe(
            `Seconds to wait for the video to become ready (0-${maxWait}). Omit or 0 to check once.`,
          ),
      }),
    },
    async ({ video_id, wait_seconds }) =>
      runTool("video_info", async () => {
        const started = Date.now();
        let info = await deps.backend.getInfo(video_id);
        let remainingMs = (wait_seconds ?? 0) * 1000;
        while (!isSettled(info) && remainingMs > 0) {
          const step = Math.min(pollMs, remainingMs);
          await sleep(step);
          remainingMs -= step;
          info = await deps.backend.getInfo(video_id);
        }
        log("video.info", { video_id, status: info.status, duration_ms: Date.now() - started });
        const expiresAt = deleteAfter(info.createdAt, deps.config.videoRetentionHours);
        return {
          content: [
            jsonContent({
              id: info.id,
              status: info.status,
              duration: info.duration,
              width: info.width,
              height: info.height,
              ...(info.pctComplete !== undefined && { pct_complete: info.pctComplete }),
              ...(expiresAt !== undefined && { delete_after: expiresAt }),
              ready: info.status === "ready" && info.duration !== undefined,
            }),
          ],
        };
      }),
  );
}
