/**
 * Real Cloudflare Stream scenario against a deployed (or `wrangler dev`) Seekio.
 *
 *   SEEKIO_MCP_URL=https://seekio.<account>.workers.dev/mcp \
 *   SEEKIO_FIXTURE_VIDEO=./fixtures/drawer.mp4 \
 *   SEEKIO_AUTH_TOKEN=... CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
 *   mise run test:integration
 *
 * Set SEEKIO_FIXTURE_SPEECH_VIDEO (a video with speech) and SEEKIO_FIXTURE_SPEECH_LANGUAGES (for
 * example `ja,en`) to also run the video_transcript scenario.
 * Set SEEKIO_FIXTURE_VIDEO_URL (a public direct video file URL) to also run the video_import_url scenario.
 * Cloudflare Stream rejects a URL it has already imported (URL_ALREADY_IMPORTED), so the scenario
 * cannot be re-run with the same URL while the earlier video exists; the test deletes its video
 * at the end, but if a run aborts midway, delete the leftover video or use a different URL.
 */
import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { McpHttpClient, type ToolResult } from "./mcp-client";

const MCP_URL = process.env.SEEKIO_MCP_URL;
const FIXTURE = process.env.SEEKIO_FIXTURE_VIDEO;
const FIXTURE_URL = process.env.SEEKIO_FIXTURE_VIDEO_URL;
const SPEECH_FIXTURE = process.env.SEEKIO_FIXTURE_SPEECH_VIDEO;
const SPEECH_LANGUAGES = (process.env.SEEKIO_FIXTURE_SPEECH_LANGUAGES ?? "")
  .split(",")
  .map((language) => language.trim())
  .filter((language) => language !== "");
const READY_TIMEOUT_MS = 5 * 60 * 1000;
const WAIT_SECONDS = 25;
const execFileAsync = promisify(execFile);

/** Escapes a path for the `-F 'file=@"<PATH>"'` slot of upload_command. */
function escapeUploadPath(path: string): string {
  if (path.includes("'")) {
    throw new Error(
      `SEEKIO_FIXTURE_VIDEO resolves to a path containing a single quote (${path}); upload_command cannot represent it. Move the fixture to a path without '.`,
    );
  }
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

type InfoResult = { status: string; duration?: number; ready: boolean };

/** Calls video_info with wait_seconds until the video is ready, errored, or the deadline passes. */
async function waitUntilReady(client: McpHttpClient, videoId: string): Promise<InfoResult> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let info: InfoResult = { status: "", ready: false };
  while (Date.now() < deadline) {
    info = json(
      await client.callTool("video_info", { video_id: videoId, wait_seconds: WAIT_SECONDS }),
    );
    if (info.ready || info.status === "error") break;
  }
  return info;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.SEEKIO_AUTH_TOKEN)
    headers.authorization = `Bearer ${process.env.SEEKIO_AUTH_TOKEN}`;
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  }
  return headers;
}

function json<T>(result: ToolResult): T {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as T;
}

function expectJpegImages(result: ToolResult, expectedCount: number): void {
  expect(result.isError).toBeUndefined();
  const images = result.content.filter((c) => c.type === "image");
  expect(images).toHaveLength(expectedCount);
  for (const image of images) {
    if (image.type !== "image") continue;
    expect(image.mimeType).toBe("image/jpeg");
    const bytes = Buffer.from(image.data, "base64");
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  }
  // Every image is preceded by its timestamp text.
  result.content.forEach((content, index) => {
    if (content.type === "image") {
      const previous = result.content[index - 1];
      expect(
        previous?.type === "text" &&
          /^Frame at [\d.]+s(, region .+ \(\d+x\d+ px\))?$/.test(previous.text),
      ).toBe(true);
    }
  });
}

const describeIf = MCP_URL && FIXTURE ? describe : describe.skip;

describeIf("Seekio against real Cloudflare Stream", () => {
  it(
    "uploads, inspects, and deletes a video end to end",
    async () => {
      const client = new McpHttpClient({ url: MCP_URL as string, headers: authHeaders() });
      const init = await client.initialize();
      expect(init.serverInfo.name).toBe("seekio");
      expect((await client.listTools()).tools).toHaveLength(8);

      const upload = json<{ video_id: string; upload_url: string; upload_command: string }>(
        await client.callTool("video_create_upload", { filename: basename(FIXTURE as string) }),
      );
      expect(upload.upload_command).toContain("<PATH>");
      // Run the returned command in a real shell, substituting the fixture's absolute path the way
      // an agent would: `"` and `\` are backslash-escaped for curl, `'` cannot be represented.
      const command = upload.upload_command.replace("<PATH>", () =>
        escapeUploadPath(resolve(FIXTURE as string)),
      );
      const { stdout } = await execFileAsync("sh", ["-c", command]);
      // Whatever curl printed for the response body, the last line names the uploaded video.
      expect(stdout.trimEnd().split("\n").at(-1)).toBe(`uploaded video_id=${upload.video_id}`);

      const info = await waitUntilReady(client, upload.video_id);
      expect(info.ready).toBe(true);
      const duration = info.duration as number;

      const overview = await client.callTool("video_overview", {
        video_id: upload.video_id,
        max_frames: 4,
      });
      expectJpegImages(overview, Math.min(4, Math.max(1, Math.ceil(duration * 1000))));

      const end = Math.min(duration, 1);
      const frames = await client.callTool("video_frames", {
        video_id: upload.video_id,
        start: 0,
        end,
        fps: 2,
      });
      expectJpegImages(frames, Math.floor(end * 2) + 1);

      const frame = await client.callTool("video_frame", {
        video_id: upload.video_id,
        at: duration / 2,
      });
      expectJpegImages(frame, 1);

      // region: crop the bottom 20% of the source-resolution frame through the Images binding.
      const cropped = await client.callTool("video_frame", {
        video_id: upload.video_id,
        at: duration / 2,
        region: { x: 0, y: 0.8, width: 1, height: 0.2 },
      });
      expectJpegImages(cropped, 1);
      const caption = cropped.content[0];
      expect(caption?.type === "text" ? caption.text : "").toMatch(
        /region x=0 y=0\.8 w=1 h=0\.2 \(\d+x\d+ px\)/,
      );

      const first = json<{ deleted: boolean }>(
        await client.callTool("video_delete", { video_id: upload.video_id }),
      );
      const second = json<{ deleted: boolean }>(
        await client.callTool("video_delete", { video_id: upload.video_id }),
      );
      expect(first.deleted).toBe(true);
      expect(second.deleted).toBe(true);
    },
    10 * 60 * 1000,
  );
});

const describeUrlIf = MCP_URL && FIXTURE_URL ? describe : describe.skip;

describeUrlIf("Seekio video_import_url against real Cloudflare Stream", () => {
  it(
    "imports a URL, inspects, and deletes the video end to end",
    async () => {
      const client = new McpHttpClient({ url: MCP_URL as string, headers: authHeaders() });
      await client.initialize();

      const imported = json<{ video_id: string; status: string }>(
        await client.callTool("video_import_url", { url: FIXTURE_URL as string }),
      );
      expect(imported.video_id).toBeTruthy();

      const info = await waitUntilReady(client, imported.video_id);
      expect(info.ready).toBe(true);
      const duration = info.duration as number;

      const overview = await client.callTool("video_overview", {
        video_id: imported.video_id,
        max_frames: 4,
      });
      expectJpegImages(overview, Math.min(4, Math.max(1, Math.ceil(duration * 1000))));

      const end = Math.min(duration, 1);
      const frames = await client.callTool("video_frames", {
        video_id: imported.video_id,
        start: 0,
        end,
        fps: 2,
      });
      expectJpegImages(frames, Math.floor(end * 2) + 1);

      const frame = await client.callTool("video_frame", {
        video_id: imported.video_id,
        at: duration / 2,
      });
      expectJpegImages(frame, 1);

      const deleted = json<{ deleted: boolean }>(
        await client.callTool("video_delete", { video_id: imported.video_id }),
      );
      expect(deleted.deleted).toBe(true);
    },
    10 * 60 * 1000,
  );
});

if (!MCP_URL || !FIXTURE) {
  console.log(
    "integration: set SEEKIO_MCP_URL and SEEKIO_FIXTURE_VIDEO to run the real Stream scenario",
  );
}

const describeSpeechIf =
  MCP_URL && SPEECH_FIXTURE && SPEECH_LANGUAGES.length > 0 ? describe : describe.skip;

describeSpeechIf("Seekio video_transcript against real Cloudflare Stream", () => {
  it(
    "uploads a video with speech, transcribes it in each language, and deletes it",
    async () => {
      const client = new McpHttpClient({ url: MCP_URL as string, headers: authHeaders() });
      await client.initialize();

      const upload = json<{ video_id: string; upload_command: string }>(
        await client.callTool("video_create_upload", {
          filename: basename(SPEECH_FIXTURE as string),
        }),
      );
      const command = upload.upload_command.replace("<PATH>", () =>
        escapeUploadPath(resolve(SPEECH_FIXTURE as string)),
      );
      await execFileAsync("sh", ["-c", command]);

      try {
        const info = await waitUntilReady(client, upload.video_id);
        expect(info.ready).toBe(true);
        const duration = info.duration as number;

        type Transcript = {
          language: string;
          status: string;
          cues?: Array<{ start: number; end: number; text: string }>;
        };
        let transcripts: Transcript[] = [];
        const deadline = Date.now() + READY_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const result = await client.callTool("video_transcript", {
            video_id: upload.video_id,
            languages: SPEECH_LANGUAGES,
            wait_seconds: WAIT_SECONDS,
          });
          expect(result.isError).toBeUndefined();
          transcripts = json<{ transcripts: Transcript[] }>(result).transcripts;
          if (transcripts.every((t) => t.status !== "inprogress")) break;
        }

        expect(transcripts.map((t) => t.language)).toEqual(SPEECH_LANGUAGES);
        for (const transcript of transcripts) {
          expect(transcript.status).toBe("ready");
          expect(transcript.cues?.length ?? 0).toBeGreaterThan(0);
          for (const cue of transcript.cues ?? []) {
            expect(cue.start).toBeGreaterThanOrEqual(0);
            expect(cue.end).toBeGreaterThan(cue.start);
            expect(cue.end).toBeLessThanOrEqual(duration);
            expect(cue.text.length).toBeGreaterThan(0);
          }
        }
      } finally {
        await client.callTool("video_delete", { video_id: upload.video_id });
      }
    },
    10 * 60 * 1000,
  );
});
