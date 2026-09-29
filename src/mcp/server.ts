import { McpServer } from "@modelcontextprotocol/server";
import pkg from "../../package.json";
import type { SeekioConfig } from "../config";
import { log } from "../log";
import type { VideoBackend, VideoInfo } from "../video/backend";
import type { ImageCropper } from "../video/image";
import { isSeekioError, messages, SeekioError, type SeekioErrorCode } from "./errors";
import { buildInstructions } from "./instructions";
import { registerCreateUpload } from "./tools/create-upload";
import { registerDelete } from "./tools/delete";
import { registerFrame } from "./tools/frame";
import { registerFrames } from "./tools/frames";
import { registerImportUrl } from "./tools/import-url";
import { registerInfo } from "./tools/info";
import { registerOverview } from "./tools/overview";
import { registerTranscript } from "./tools/transcript";

export const serverInfo = { name: "seekio", version: pkg.version } as const;

export type ToolDeps = {
  backend: VideoBackend;
  config: SeekioConfig;
  /** Crops `video_frame` regions. Absent when the Images binding is not configured. */
  cropper?: ImageCropper;
  /** Waits for `ms` milliseconds. Defaults to a real timer; tests inject a fake. */
  sleep?: (ms: number) => Promise<void>;
};

/** Error codes that originate in the video provider and therefore deserve a `backend.error` log line. */
const BACKEND_ERROR_CODES = new Set<SeekioErrorCode>([
  "BACKEND_ERROR",
  "FRAME_FETCH_FAILED",
  "UPLOAD_CREATE_FAILED",
  "REGION_CROP_FAILED",
  "NO_AUDIO_TRACK",
  "UNSUPPORTED_LANGUAGE",
  "TRANSCRIPT_FAILED",
]);

type ToolResult = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/jpeg" }
  >;
  isError?: boolean;
};

export function jsonContent(value: unknown): ToolResult["content"][number] {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

/** Runs a tool body and converts Seekio/unknown errors into an `isError` result the agent can act on. */
export async function runTool(tool: string, body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (error) {
    const seekioError = isSeekioError(error)
      ? error
      : new SeekioError(
          "BACKEND_ERROR",
          `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        );
    if (BACKEND_ERROR_CODES.has(seekioError.code)) {
      log("backend.error", { tool, code: seekioError.code, message: seekioError.message });
    }
    return {
      isError: true,
      content: [{ type: "text", text: `[${seekioError.code}] ${seekioError.message}` }],
    };
  }
}

/** Fetches info and refuses frame work unless the video is ready with a known duration. */
export async function requireReady(
  deps: ToolDeps,
  videoId: string,
): Promise<VideoInfo & { duration: number }> {
  const info = await deps.backend.getInfo(videoId);
  if (info.status === "error") {
    throw new SeekioError("VIDEO_PROCESSING_FAILED", messages.processingFailed);
  }
  if (info.status !== "ready" || info.duration === undefined) {
    throw new SeekioError("VIDEO_NOT_READY", messages.notReady);
  }
  const limit = deps.config.maxVideoDurationSeconds;
  if (info.duration > limit) {
    throw new SeekioError(
      "VIDEO_TOO_LONG",
      messages.tooLong(Math.ceil(info.duration * 10) / 10, limit),
    );
  }
  return { ...info, duration: info.duration };
}

export function createSeekioServer(deps: ToolDeps): McpServer {
  const server = new McpServer(serverInfo, {
    instructions: buildInstructions(deps.config.videoRetentionHours),
  });
  registerCreateUpload(server, deps);
  registerImportUrl(server, deps);
  registerInfo(server, deps);
  registerOverview(server, deps);
  registerFrames(server, deps);
  registerFrame(server, deps);
  registerTranscript(server, deps);
  registerDelete(server, deps);
  return server;
}
