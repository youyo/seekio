/** One caption cue; `start` and `end` are seconds with millisecond precision. */
export type Cue = { start: number; end: number; text: string };

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/;
const TIMING_LINE = /^(\S+)\s*-->\s*(\S+)/;
const NON_CUE_BLOCKS = /^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/;

/** Markup tags inside cue text: <v Name>, <c.x>, <b>, <i>, <u>, <ruby>, <rt>, <lang x> and <00:01.000>. */
const CUE_TAG = /<\/?[a-zA-Z][^>]*>|<\d[\d:.]*>/g;
const ENTITY = /&(amp|lt|gt|nbsp|quot|apos|lrm|rlm|#\d+|#x[0-9a-f]+);/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  quot: '"',
  apos: "'",
  lrm: "",
  rlm: "",
};

function decodeEntity(match: string, body: string): string {
  const named = NAMED_ENTITIES[body.toLowerCase()];
  if (named !== undefined) return named;
  const code =
    body[1]?.toLowerCase() === "x" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : match;
}

/** Removes markup tags, then decodes character references once (so `&amp;lt;` stays `&lt;`). */
function cleanCueLine(line: string): string {
  return line.replace(CUE_TAG, "").replace(ENTITY, decodeEntity).trim();
}

function parseTimestamp(raw: string): number | undefined {
  const match = TIMESTAMP.exec(raw);
  if (!match) return undefined;
  const [, hours, minutes, seconds, millis] = match;
  const totalMs =
    (Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(millis);
  // Integer milliseconds / 1000 is the nearest double, so 62003 -> 62.003 without float noise.
  return totalMs / 1000;
}

/**
 * Parses a WebVTT document into cues. Handles the header, NOTE/STYLE/REGION blocks, cue ids,
 * `HH:MM:SS.mmm` and `MM:SS.mmm` timestamps, multi-line text and cue settings (`align:` ...).
 * Cues with no text, with zero length, or that end before they start are dropped.
 */
export function parseVtt(vtt: string): Cue[] {
  const lines = vtt.replace(/^﻿/, "").split(/\r?\n/);
  const cues: Cue[] = [];
  let block: string[] = [];
  const flush = () => {
    const current = block;
    block = [];
    const first = current[0]?.trim();
    if (first === undefined || NON_CUE_BLOCKS.test(first)) return;
    const timingIndex = current.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return;
    const match = TIMING_LINE.exec((current[timingIndex] as string).trim());
    if (!match) return;
    const start = parseTimestamp(match[1] as string);
    const end = parseTimestamp(match[2] as string);
    if (start === undefined || end === undefined || !(end > start)) return;
    const text = current
      .slice(timingIndex + 1)
      .map(cleanCueLine)
      .filter((line) => line !== "")
      .join("\n");
    if (text === "") return;
    cues.push({ start, end, text });
  };
  for (const line of lines) {
    if (line.trim() === "") flush();
    else block.push(line);
  }
  flush();
  return cues;
}

/** Cues that overlap `[start, end]` (touching the boundary counts). */
export function cuesInRange(cues: readonly Cue[], start: number, end: number): Cue[] {
  return cues.filter((cue) => cue.end >= start && cue.start <= end);
}
