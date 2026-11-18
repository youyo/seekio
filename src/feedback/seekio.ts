/**
 * feedback ツールの匿名化ルールのうち、seekio 固有の部分(共通仕様 §7.2)。
 * 共通の部分は guide.ts。仕様の正: https://github.com/youyo/logbutler/blob/main/docs/adr/0019-feedback-tool.md
 */
import { SEEKIO_ERROR_CODES } from "../mcp/errors";

/** seekio 固有のプレースホルダは無い。共通の 6 個(guide.ts の COMMON_PLACEHOLDERS)だけを返す。 */
export const SEEKIO_PLACEHOLDERS: readonly string[] = [];

/**
 * seekio 固有の匿名化ルール。共通のルールに続けて返す。プレースホルダはバッククォートで囲む。
 * 残してよい固定のエラーコードは src/mcp/errors.ts の SEEKIO_ERROR_CODES(エラー `[CODE] message` の CODE)。
 */
export const SEEKIO_ANONYMIZATION_RULES: readonly string[] = [
  "video_id は `<ID>` にする",
  "upload_url・upload_command・署名付きのサムネイルや字幕の URL・取り込み元の動画 URL は書かない（URL ごと落とす）",
  "動画の内容（フレームや切り出しの画像・画面に写った文字・文字起こしの本文）と動画のファイル名は貼らない。現象の説明に必要なら一般的な説明にする",
  `残してよい公開固定値は、seekio の公開ツール名と、固定のエラーコード（エラー \`[CODE] message\` の CODE の部分だけ。message は貼らない。使える CODE: ${SEEKIO_ERROR_CODES.map((c) => `\`${c}\``).join(" ")}）`,
];
