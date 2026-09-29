import { describe, expect, it } from "vitest";
import { cuesInRange, parseVtt } from "../../src/video/vtt";

describe("parseVtt", () => {
  it("parses the header, cue ids, HH:MM:SS.mmm and MM:SS.mmm timestamps", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.500 --> 00:00:03.250",
      "Hello there",
      "",
      "00:05.000 --> 01:02.003",
      "Second cue",
      "",
      "01:00:00.000 --> 01:00:01.000",
      "Over an hour",
    ].join("\n");
    expect(parseVtt(vtt)).toEqual([
      { start: 1.5, end: 3.25, text: "Hello there" },
      { start: 5, end: 62.003, text: "Second cue" },
      { start: 3600, end: 3601, text: "Over an hour" },
    ]);
  });

  it("skips the header text, NOTE, STYLE and REGION blocks", () => {
    const vtt = [
      "WEBVTT - generated",
      "Kind: captions",
      "",
      "NOTE this is a comment",
      "00:00:09.000 --> 00:00:10.000",
      "",
      "STYLE",
      "::cue { color: red }",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "kept",
    ].join("\n");
    expect(parseVtt(vtt)).toEqual([{ start: 1, end: 2, text: "kept" }]);
  });

  it("keeps multi-line text, trims lines, and handles CRLF and a BOM", () => {
    const vtt = "﻿WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\n  line one \r\nline two  \r\n\r\n";
    expect(parseVtt(vtt)).toEqual([{ start: 1, end: 2, text: "line one\nline two" }]);
  });

  it("ignores cue settings after the end time", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start position:10%\nhi";
    expect(parseVtt(vtt)).toEqual([{ start: 1, end: 2, text: "hi" }]);
  });

  it("drops zero-length cues, empty cues, and end-before-start cues", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:01:32.236 --> 00:01:32.236",
      "zero",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "   ",
      "",
      "00:00:05.000 --> 00:00:04.000",
      "backwards",
      "",
      "00:00:06.000 --> 00:00:07.000",
      "ok",
    ].join("\n");
    expect(parseVtt(vtt)).toEqual([{ start: 6, end: 7, text: "ok" }]);
  });

  it("returns an empty list for empty or header-only input", () => {
    expect(parseVtt("")).toEqual([]);
    expect(parseVtt("WEBVTT\n")).toEqual([]);
  });

  it("keeps millisecond precision without float noise", () => {
    const vtt = "WEBVTT\n\n00:00:00.001 --> 00:00:00.290\nx";
    expect(parseVtt(vtt)).toEqual([{ start: 0.001, end: 0.29, text: "x" }]);
  });
});

describe("parseVtt cue text markup", () => {
  const one = (text: string) =>
    parseVtt(`WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${text}`).map((c) => c.text);

  it("strips voice, class, style, ruby, lang and timestamp tags", () => {
    expect(one("<v Speaker>Hello</v> <c.yellow>there</c> <b>b</b><i>i</i><u>u</u>")).toEqual([
      "Hello there biu",
    ]);
    expect(one("<ruby>漢字<rt>かんじ</rt></ruby> <lang en>hi</lang>")).toEqual(["漢字かんじ hi"]);
    expect(one("word<00:00:01.500>next <00:01.700>end")).toEqual(["wordnext end"]);
  });

  it("decodes basic character references", () => {
    expect(one("a &amp; b &lt;c&gt;&nbsp;d &quot;q&quot; &#39;s&#39; &lrm;")).toEqual([
      "a & b <c> d \"q\" 's'",
    ]);
  });

  it("does not double-decode and keeps literal text from &lt;tag&gt;", () => {
    expect(one("&amp;lt; &lt;b&gt;x")).toEqual(["&lt; <b>x"]);
  });

  it("drops cues that are empty after stripping", () => {
    expect(one("<v A></v>\n<c> </c>")).toEqual([]);
  });
});

describe("cuesInRange", () => {
  const cues = [
    { start: 0, end: 2, text: "a" },
    { start: 2, end: 4, text: "b" },
    { start: 5, end: 6, text: "c" },
  ];

  it("keeps cues that overlap [start, end]", () => {
    expect(cuesInRange(cues, 3, 5.5).map((c) => c.text)).toEqual(["b", "c"]);
  });

  it("includes a cue that touches the boundary", () => {
    expect(cuesInRange(cues, 4, 5).map((c) => c.text)).toEqual(["b", "c"]);
  });

  it("returns everything for the full range", () => {
    expect(cuesInRange(cues, 0, 100)).toHaveLength(3);
  });
});
