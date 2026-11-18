/**
 * seekio_feedback の E2E 相当。worker.fetch で /mcp を通し、env とリクエストのホストが違う 2 構成でも
 * kind ごとの応答が完全に一致すること、環境の値(番兵)が応答に現れないことを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { buildFeedbackGuide, FEEDBACK_KINDS } from "../../src/feedback/guide";
import worker from "../../src/index";

const ctx = {} as ExecutionContext;

type Config = { name: string; host: string; env: Env; headers: Record<string, string> };

const configs: Config[] = [
  {
    name: "A: token, short retention, images binding",
    host: "a.example",
    env: {
      STREAM: {} as StreamBinding,
      IMAGES: {} as ImagesBinding,
      SEEKIO_AUTH_TOKEN: "sentinel-token-aaaa",
      VIDEO_RETENTION_HOURS: "7",
      MAX_VIDEO_DURATION_SECONDS: "111",
    },
    headers: { authorization: "Bearer sentinel-token-aaaa" },
  },
  {
    name: "B: no auth, default limits, no images binding",
    host: "b.example",
    env: { STREAM: {} as StreamBinding },
    headers: {},
  },
];

const SENTINELS = ["sentinel-token-aaaa", "a.example", "b.example"];

async function mcp(config: Config, method: string, params: unknown): Promise<unknown> {
  const response = await worker.fetch(
    new Request(`https://${config.host}/mcp`, {
      method: "POST",
      headers: {
        ...config.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    config.env,
    ctx,
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .at(-1)
    : text;
  const message = JSON.parse(payload ?? "{}") as { result?: unknown; error?: unknown };
  expect(message.error).toBeUndefined();
  return message.result;
}

type CallResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("seekio_feedback through worker.fetch /mcp", () => {
  it("is listed with the same single-input schema in both configurations", async () => {
    for (const config of configs) {
      const { tools } = (await mcp(config, "tools/list", {})) as {
        tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
      };
      const tool = tools.find((t) => t.name === "seekio_feedback");
      expect(tool, config.name).toBeDefined();
      expect(Object.keys(tool?.inputSchema.properties ?? {}), config.name).toEqual(["kind"]);
    }
  });

  it.each(FEEDBACK_KINDS)(
    "kind=%s: the response is identical across both configurations",
    async (kind) => {
      const texts: string[] = [];
      for (const config of configs) {
        const result = (await mcp(config, "tools/call", {
          name: "seekio_feedback",
          arguments: { kind },
        })) as CallResult;
        expect(result.isError, config.name).toBeUndefined();
        expect(result.content, config.name).toHaveLength(1);
        const text = result.content[0]?.text ?? "";
        expect(JSON.parse(text), config.name).toEqual(buildFeedbackGuide(kind));
        for (const sentinel of SENTINELS) {
          expect(text, `${config.name}: ${sentinel}`).not.toContain(sentinel);
        }
        texts.push(text);
      }
      expect(texts[0]).toBe(texts[1]);
    },
  );

  it("defaults to bug when kind is omitted, identically in both configurations", async () => {
    const texts: string[] = [];
    for (const config of configs) {
      const result = (await mcp(config, "tools/call", {
        name: "seekio_feedback",
        arguments: {},
      })) as CallResult;
      texts.push(result.content[0]?.text ?? "");
    }
    expect(texts[0]).toBe(texts[1]);
    expect(JSON.parse(texts[0] ?? "")).toEqual(buildFeedbackGuide("bug"));
  });

  it("never calls fetch (no external communication) for any kind", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("external fetch is forbidden");
    });
    vi.stubGlobal("fetch", fetchSpy);
    for (const config of configs) {
      for (const kind of [...FEEDBACK_KINDS, undefined]) {
        const result = (await mcp(config, "tools/call", {
          name: "seekio_feedback",
          arguments: kind === undefined ? {} : { kind },
        })) as CallResult;
        expect(result.isError, `${config.name} ${kind}`).toBeUndefined();
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
