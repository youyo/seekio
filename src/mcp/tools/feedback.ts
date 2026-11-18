import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildFeedbackGuide, FEEDBACK_DESCRIPTION, FEEDBACK_KINDS } from "../../feedback/guide";
import { jsonContent, runTool, type ToolDeps } from "../server";

// feedback ツール。上流の公開リポジトリ youyo/seekio に issue を起票するための案内を返す。
// issue は作らず、GitHub にも Cloudflare にも通信しない。応答は kind だけで決まり、deps は使わない。

export function registerFeedback(server: McpServer, _deps: ToolDeps): void {
  server.registerTool(
    "seekio_feedback",
    {
      title: "フィードバック（GitHub issue の起票案内）",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      // 開始条件・中止条件・承認の固定文を含む(src/feedback/guide.ts。steps と同じ文言)
      description: FEEDBACK_DESCRIPTION,
      inputSchema: z.object({
        kind: z
          .enum(FEEDBACK_KINDS)
          .describe("Type of feedback: bug, feature, question or other (default: bug)")
          .optional(),
      }),
    },
    async ({ kind }) =>
      runTool("seekio_feedback", async () => ({
        content: [jsonContent(buildFeedbackGuide(kind ?? "bug"))],
      })),
  );
}
