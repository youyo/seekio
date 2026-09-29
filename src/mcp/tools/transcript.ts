import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../log";
import { CAPTION_LANGUAGES, type Caption } from "../../video/backend";
import { type Cue, cuesInRange, parseVtt } from "../../video/vtt";
import { isSeekioError, SeekioError } from "../errors";
import { jsonContent, requireReady, runTool, type ToolDeps } from "../server";
import { videoIdSchema } from "./info";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Transcript = {
  language: string;
  status: "ready" | "inprogress" | "error";
  cues?: Cue[];
  message?: string;
};

/** Resolves the optional range against the video like the frame tools do. */
function transcriptRange(
  start: number | undefined,
  end: number | undefined,
  duration: number,
): { start: number; end: number } {
  const from = start ?? 0;
  const to = end ?? duration;
  if (end !== undefined && end > duration) {
    throw new SeekioError(
      "INVALID_INTERVAL",
      `end (${end}s) exceeds the video duration (${duration}s).`,
    );
  }
  if (!(to > from)) {
    throw new SeekioError(
      "INVALID_INTERVAL",
      `end must be greater than start (start ${from}s, end ${to}s, video duration ${duration}s).`,
    );
  }
  return { start: from, end: to };
}

const isSettled = (caption: Caption | undefined) =>
  caption !== undefined && caption.status !== "inprogress";

export function registerTranscript(server: McpServer, deps: ToolDeps): void {
  const sleep = deps.sleep ?? defaultSleep;
  const maxWait = deps.config.infoMaxWaitSeconds;
  const pollMs = deps.config.infoPollIntervalMs;
  server.registerTool(
    "video_transcript",
    {
      title: "Video transcript",
      description: `Get the spoken words of a video as timestamped text cues [{ start, end, text }] (seconds, millisecond precision, the same unit as the at of video_frame), using Cloudflare Stream's AI captions. It does not play audio and does not analyze sound or waveforms; it only returns Stream's speech-to-text with times. Use it to check what is said when, for example whether on-screen subtitles match the narration: get the cue times here, then look at the frames around them with video_frames. There is no automatic language detection: pass the language that is spoken in languages (${CAPTION_LANGUAGES.join(", ")}; plain codes such as en, not en-US), one to three of them. If the video mixes languages or you do not know the language, pass all candidates together, for example ["ja","en"]. Each language's result is only reliable in the parts where that language is actually spoken; the other parts are misrecognized or hallucinated text (for example a stock phrase like a sign-off), so ignore them. Cue times are accurate to about ±0.5 seconds, a sentence can be split into several cues, and cues are per phrase rather than per word. Generation is asynchronous (roughly 10 seconds for a 3-minute video) and the first call starts it: if a language is still "inprogress", call again with wait_seconds (0-${maxWait}, same as video_info). start and end (seconds) limit the returned cues to that range. Videos without an audio track fail with NO_AUDIO_TRACK.`,
      inputSchema: z.object({
        video_id: videoIdSchema,
        languages: z
          .array(z.enum(CAPTION_LANGUAGES))
          .min(1)
          .max(3)
          .refine((list) => new Set(list).size === list.length, {
            message: "languages must not contain duplicates.",
          })
          .describe(
            'One to three languages spoken in the video, from: cs, nl, en, fr, de, it, ja, ko, pl, pt, ru, es. Example: ["ja","en"].',
          ),
        start: z.number().min(0).optional().describe("Only return cues from this time (seconds)."),
        end: z
          .number()
          .positive()
          .optional()
          .describe("Only return cues up to this time (seconds)."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(maxWait)
          .optional()
          .describe(
            `Seconds to wait for captions that are still being generated (0-${maxWait}). Omit or 0 to check once.`,
          ),
      }),
    },
    async ({ video_id, languages, start, end, wait_seconds }) =>
      runTool("video_transcript", async () => {
        const started = Date.now();
        const info = await requireReady(deps, video_id);
        const range = transcriptRange(start, end, info.duration);

        const existing = await deps.backend.getCaptions(video_id);
        const missing = languages.filter((l) => !existing.some((c) => c.language === l));
        await Promise.all(missing.map((l) => deps.backend.generateCaption(video_id, l)));

        const snapshot = async () => {
          const captions = await deps.backend.getCaptions(video_id);
          return languages.map((l) => captions.find((c) => c.language === l));
        };
        let current = await snapshot();
        let remainingMs = (wait_seconds ?? 0) * 1000;
        while (!current.every(isSettled) && remainingMs > 0) {
          const step = Math.min(pollMs, remainingMs);
          await sleep(step);
          remainingMs -= step;
          current = await snapshot();
        }

        const transcripts: Transcript[] = await Promise.all(
          languages.map(async (language, index): Promise<Transcript> => {
            const caption = current[index];
            if (caption?.status === "ready") {
              try {
                const vtt = await deps.backend.getCaptionText(video_id, language);
                return {
                  language,
                  status: "ready",
                  cues: cuesInRange(parseVtt(vtt), range.start, range.end),
                };
              } catch (error) {
                if (!isSeekioError(error)) throw error;
                return { language, status: "error", message: error.message };
              }
            }
            if (caption?.status === "error") {
              return {
                language,
                status: "error",
                message: `Stream failed to generate the ${language} captions. Try another language.`,
              };
            }
            return { language, status: "inprogress" };
          }),
        );

        if (transcripts.every((t) => t.status === "error")) {
          throw new SeekioError(
            "TRANSCRIPT_FAILED",
            transcripts.map((t) => `${t.language}: ${t.message ?? "failed"}`).join(" / "),
          );
        }
        const pending = transcripts.some((t) => t.status === "inprogress");
        log("transcript.requested", {
          video_id,
          languages: languages.join(","),
          statuses: transcripts.map((t) => t.status).join(","),
          duration_ms: Date.now() - started,
        });
        return {
          content: [
            jsonContent({
              video_id,
              transcripts,
              ...(pending && {
                note: `Some languages are still being generated. Call video_transcript again with wait_seconds (up to ${maxWait}) to wait for them.`,
              }),
            }),
          ],
        };
      }),
  );
}
