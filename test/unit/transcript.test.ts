import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaults } from "../../src/config";
import { SeekioError } from "../../src/mcp/errors";
import { CAPTION_LANGUAGES } from "../../src/video/backend";
import { FakeVideoBackend } from "./fake-backend";
import { createHarness, jsonOf, textOf } from "./mcp-harness";

type Cue = { start: number; end: number; text: string };
type Transcript = { language: string; status: string; cues?: Cue[]; message?: string };
type Output = { video_id: string; transcripts: Transcript[]; note?: string };

let backend: FakeVideoBackend;
let sleeps: number[];
let harness: ReturnType<typeof createHarness>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  backend = new FakeVideoBackend();
  backend.addVideo({ id: "v", duration: 10 });
  sleeps = [];
  harness = createHarness(backend, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
});

const generated = () => backend.calls.filter((c) => c.op === "generateCaption");

describe("video_transcript registration", () => {
  it("documents scope, language handling, and accuracy", async () => {
    const { tools } = await harness.listTools();
    const tool = tools.find((t) => t.name === "video_transcript");
    const desc = tool?.description ?? "";
    expect(desc).toMatch(/does not play|not .*playback|waveform/i);
    expect(desc).toMatch(/no automatic language detection|not detected automatically/i);
    expect(desc).toContain('["ja","en"]');
    expect(desc).toMatch(/only reliable|hallucinat/i);
    expect(desc).toContain("0.5");
    expect(desc).toContain("wait_seconds");
  });

  it("accepts exactly the twelve supported languages", () => {
    expect([...CAPTION_LANGUAGES].sort()).toEqual(
      ["cs", "nl", "en", "fr", "de", "it", "ja", "ko", "pl", "pt", "ru", "es"].sort(),
    );
  });
});

describe("video_transcript", () => {
  it("generates a missing caption, reports inprogress and tells the agent to call again", async () => {
    const result = await harness.callTool("video_transcript", { video_id: "v", languages: ["ja"] });
    expect(result.isError).toBeFalsy();
    const out = jsonOf<Output>(result);
    expect(out.transcripts).toEqual([{ language: "ja", status: "inprogress" }]);
    expect(out.note).toMatch(/wait_seconds/);
    expect(generated()).toEqual([{ op: "generateCaption", videoId: "v", language: "ja" }]);
  });

  it("waits with wait_seconds until ready, then returns ms-precision cues without zero-length ones", async () => {
    const result = await harness.callTool("video_transcript", {
      video_id: "v",
      languages: ["ja"],
      wait_seconds: 10,
    });
    const out = jsonOf<Output>(result);
    expect(out.note).toBeUndefined();
    expect(out.transcripts).toEqual([
      {
        language: "ja",
        status: "ready",
        cues: [
          { start: 1, end: 2.5, text: "hello ja" },
          { start: 8, end: 9, text: "later ja" },
        ],
      },
    ]);
    expect(sleeps).toEqual([defaults.infoPollIntervalMs]);
  });

  it("stops waiting when wait_seconds runs out", async () => {
    backend.listsUntilReady = 100;
    const out = jsonOf<Output>(
      await harness.callTool("video_transcript", {
        video_id: "v",
        languages: ["en"],
        wait_seconds: 5,
      }),
    );
    expect(out.transcripts[0]?.status).toBe("inprogress");
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(5000);
    expect(out.note).toMatch(/wait_seconds/);
  });

  it("does not generate again when a caption already exists", async () => {
    backend.setCaption("v", "en", { status: "ready" });
    const out = jsonOf<Output>(
      await harness.callTool("video_transcript", { video_id: "v", languages: ["en"] }),
    );
    expect(out.transcripts[0]?.status).toBe("ready");
    expect(generated()).toEqual([]);
  });

  it("handles several languages: generates only the missing ones and reports each", async () => {
    backend.setCaption("v", "en", { status: "ready" });
    const out = jsonOf<Output>(
      await harness.callTool("video_transcript", {
        video_id: "v",
        languages: ["ja", "en"],
        wait_seconds: 10,
      }),
    );
    expect(out.transcripts.map((t) => [t.language, t.status])).toEqual([
      ["ja", "ready"],
      ["en", "ready"],
    ]);
    expect(generated().map((c) => c.language)).toEqual(["ja"]);
  });

  it("filters cues to start/end (overlap) and validates the range like the frame tools", async () => {
    backend.setCaption("v", "ja", { status: "ready" });
    const out = jsonOf<Output>(
      await harness.callTool("video_transcript", {
        video_id: "v",
        languages: ["ja"],
        start: 5,
        end: 10,
      }),
    );
    expect(out.transcripts[0]?.cues).toEqual([{ start: 8, end: 9, text: "later ja" }]);

    for (const args of [{ start: 5, end: 5 }, { start: 6, end: 3 }, { end: 11 }, { start: 10 }]) {
      const bad = await harness.callTool("video_transcript", {
        video_id: "v",
        languages: ["ja"],
        ...args,
      });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toMatch(/^\[INVALID_INTERVAL\]/);
    }
  });

  it("marks an errored caption as error and throws TRANSCRIPT_FAILED when nothing usable is left", async () => {
    backend.setCaption("v", "ja", { status: "error" });
    const result = await harness.callTool("video_transcript", { video_id: "v", languages: ["ja"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^\[TRANSCRIPT_FAILED\]/);
  });

  it("reports a per-language error next to a ready language", async () => {
    backend.setCaption("v", "ja", { status: "error" });
    backend.setCaption("v", "en", { status: "ready" });
    const out = jsonOf<Output>(
      await harness.callTool("video_transcript", { video_id: "v", languages: ["ja", "en"] }),
    );
    expect(out.transcripts.map((t) => [t.language, t.status])).toEqual([
      ["ja", "error"],
      ["en", "ready"],
    ]);
    expect(out.transcripts[0]?.message).toBeTruthy();
  });

  it("reports a text fetch failure as that language's error", async () => {
    backend.setCaption("v", "ja", { status: "ready" });
    backend.setCaption("v", "en", { status: "ready" });
    backend.failTextLanguages.add("ja");
    const out = jsonOf<Output>(
      await harness.callTool("video_transcript", { video_id: "v", languages: ["ja", "en"] }),
    );
    expect(out.transcripts[0]).toMatchObject({ language: "ja", status: "error" });
    expect(out.transcripts[1]?.status).toBe("ready");
  });

  it("surfaces NO_AUDIO_TRACK and UNSUPPORTED_LANGUAGE from the backend", async () => {
    backend.generateErrors.set(
      "ja",
      new SeekioError("NO_AUDIO_TRACK", "This video has no audio track"),
    );
    const noAudio = await harness.callTool("video_transcript", {
      video_id: "v",
      languages: ["ja"],
    });
    expect(noAudio.isError).toBe(true);
    expect(textOf(noAudio)).toMatch(/^\[NO_AUDIO_TRACK\]/);
    backend.generateErrors.set("en", new SeekioError("UNSUPPORTED_LANGUAGE", "nope"));
    const unsupported = await harness.callTool("video_transcript", {
      video_id: "v",
      languages: ["en"],
    });
    expect(textOf(unsupported)).toMatch(/^\[UNSUPPORTED_LANGUAGE\]/);
  });

  it("requires a ready video", async () => {
    backend.addVideo({ id: "p", status: "inprogress" });
    const result = await harness.callTool("video_transcript", { video_id: "p", languages: ["ja"] });
    expect(textOf(result)).toMatch(/^\[VIDEO_NOT_READY\]/);
    expect(generated()).toEqual([]);
  });

  it.each([["en-US"], ["zh"], ["JA"]])(
    "rejects the language %s before touching the backend",
    async (language) => {
      const result = await harness
        .callTool("video_transcript", { video_id: "v", languages: [language] })
        .catch((e) => e);
      const rejected = result instanceof Error || result.isError === true;
      expect(rejected).toBe(true);
      expect(backend.calls.filter((c) => c.op === "generateCaption")).toEqual([]);
    },
  );

  it.each([[[]], [["ja", "ja"]], [["ja", "en", "ko", "fr"]]])(
    "rejects language lists %j (empty, duplicated, or more than 3)",
    async (languages) => {
      const result = await harness
        .callTool("video_transcript", { video_id: "v", languages })
        .catch((e) => e);
      expect(result instanceof Error || result.isError === true).toBe(true);
      expect(generated()).toEqual([]);
    },
  );

  it("rejects wait_seconds above the limit", async () => {
    const result = await harness.callTool("video_transcript", {
      video_id: "v",
      languages: ["ja"],
      wait_seconds: 26,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Input validation error/);
  });
});

describe("server instructions", () => {
  it("explain how to check subtitles against the voice", async () => {
    const { buildInstructions } = await import("../../src/mcp/instructions");
    const text = buildInstructions(24);
    expect(text).toContain("video_transcript");
    expect(text).toMatch(/video_frames/);
    expect(text).toMatch(/subtitle/i);
  });
});
