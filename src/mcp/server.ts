import { McpServer } from "@modelcontextprotocol/server";
import pkg from "../../package.json";
import type { SeekioConfig } from "../config";
import { log } from "../log";
import type { VideoBackend, VideoInfo } from "../video/backend";
import { isSeekioError, messages, SeekioError } from "./errors";
import { instructions } from "./instructions";
import { registerCreateUpload } from "./tools/create-upload";
import { registerDelete } from "./tools/delete";
import { registerFrame } from "./tools/frame";
import { registerFrames } from "./tools/frames";
import { registerInfo } from "./tools/info";
import { registerOverview } from "./tools/overview";

export const serverInfo = { name: "seekio", version: pkg.version } as const;

export type ToolDeps = {
  backend: VideoBackend;
  config: SeekioConfig;
};

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
    if (seekioError.code === "BACKEND_ERROR") {
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
  return { ...info, duration: info.duration };
}

export function createSeekioServer(deps: ToolDeps): McpServer {
  const server = new McpServer(serverInfo, { instructions });
  registerCreateUpload(server, deps);
  registerInfo(server, deps);
  registerOverview(server, deps);
  registerFrames(server, deps);
  registerFrame(server, deps);
  registerDelete(server, deps);
  return server;
}
