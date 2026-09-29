# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Seekio は Cloudflare Workers 上で動くステートレスな Remote MCP サーバー。AI エージェントに動画のタイムラインを「タイムスタンプ付き JPEG フレーム」として段階的に見せる（全体 → 怪しい区間 → 高 fps の区間 → 正確な 1 フレーム）。動画の保存とエンコードは Cloudflare Stream が担当する。Seekio 自身は動画の理解・推論・独自ストレージを一切持たない。

詳細設計は `docs/specs/seekio-detailed-design.md`（日本語）にある。v1 の非目標（R2、ffmpeg、VLM/OCR/STT、Durable Objects/D1/KV、DB など）は §3 に列挙されており、実利用で必要性が確認されるまで追加しない。

## コマンド（mise 経由）

```bash
mise run install            # pnpm install --frozen-lockfile
mise run dev                # wrangler dev (http://localhost:8787)。Stream binding は remote: true で実サービスに接続
mise run typecheck          # tsc --noEmit
mise run lint               # biome check .（フォーマットチェックを含む）
mise run test               # vitest run（unit のみ: test/unit/**）
mise run check              # typecheck + lint + test（CI はこれを実行）
mise run test:integration   # 実 Stream を使う結合テスト（下記参照）
mise run deploy             # check のあと wrangler deploy
mise run portal[:dry-run]   # MCP Server Portal への登録（冪等）
```

単一テストの実行: `pnpm vitest run test/unit/timestamps.test.ts`、またはテスト名で絞る場合は `pnpm vitest run -t "<name>"`。

補足:
- `mise.toml` には `test:unit` / `test:e2e` タスクがない。`test` は unit のみで、結合テストは `test:integration` として分離されている。
- `vitest.config.ts` は環境変数 `SEEKIO_INTEGRATION` の有無で `include` を切り替える。unit は `test/unit/**`、integration は `test/integration/**`。
- 結合テストは、デプロイ済みの Seekio（または `wrangler dev`）に対して、実際の MCP HTTP 通信で upload → info ポーリング → overview → frames → frame → delete を実行する。必要な環境変数は `SEEKIO_MCP_URL` と `SEEKIO_FIXTURE_VIDEO`（`SEEKIO_FIXTURE_VIDEO_URL` を設定すると `video_import_url` のシナリオも走る）。任意で `SEEKIO_AUTH_TOKEN` と `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` も渡せる。
- ローカルのシークレットは `.dev.vars` に置く（git 管理外）。
- 本番デプロイは Cloudflare Workers Builds（GitHub 連携）で行う。GitHub Actions は `mise run check` を実行するだけで、デプロイはしない。

## アーキテクチャ

リクエストの流れ: `src/index.ts`（Worker の fetch）→ ルーティング
- `GET /health`: 認証なし。`{status, name, version}` を返す（version は `package.json` から取得）
- `/mcp`: `authorize()`（`src/auth.ts`）→ リクエストごとに `createMcpHandler`（Agents SDK）を生成 → `createSeekioServer()`（`src/mcp/server.ts`）
- それ以外は 404

主な設計上のポイント:

- **`VideoBackend`（`src/video/backend.ts`）が動画プロバイダーとの唯一の境界。** 本番実装は `CloudflareStreamBackend`（`src/video/cloudflare-stream.ts`）で、Workers の Stream binding（`env.STREAM`）を使う。ランタイムに API トークンは不要。インスタンスはリクエストごとに作り、署名付きサムネイル URL のベースを動画ごとにメモ化する。動画は必ず `requireSignedURLs: true` で作成する。動画のバイト列が Worker を通ることはない（クライアントが one-time upload URL へ直接アップロードするか、`video_import_url` で Stream 自身が公開 URL から取り込む）。
- **ツールは `src/mcp/tools/*.ts` に 1 ファイル 1 ツールで置く。** 各ファイルが `register*(server, deps: ToolDeps)` を公開し、`createSeekioServer` がそれらを登録する。ツール本体は必ず `runTool()` で包む。`runTool()` は `SeekioError` と未知の例外を `isError: true` の `[CODE] message` に変換する。フレーム系ツールは最初に `requireReady()` を呼び、`status === "ready"` かつ duration が判明していることを確かめ、duration が `maxVideoDurationSeconds` を超えていれば `VIDEO_TOO_LONG` を返す（URL 取り込みは事前に長さを強制できないため事後検査）。URL はログに出さない。
- **エラーメッセージはエージェントへの指示になっている。** `SeekioError` のメッセージには「次に何をすべきか」を書く（`src/mcp/errors.ts` の `messages` を参照）。新しいエラーコードは `SeekioErrorCode` に追加する。プロバイダー由来のコードは `server.ts` の `BACKEND_ERROR_CODES` に入れ、`backend.error` としてログ出力されるようにする。
- **タイムスタンプの計算は `src/video/timestamps.ts` に集約する。** ミリ秒に丸め、動画末尾より 1ms 手前にクランプし、重複を除いてソートする。フレームの時刻は加算の積み重ねではなく `start + i / fps` で計算する（浮動小数点誤差を溜めないため）。上限を超えたときに fps やフレーム数を勝手に下げることはせず、`TOO_MANY_FRAMES` を返す。
- **フレーム取得**（`src/video/frame.ts`）: `fetchFramesBounded` で同時実行数を制限しつつ、結果は入力と同じ順序で返す。画像は base64 の `image/jpeg` MCP image content にし、`Frame at <t>s` のテキストと対にする。
- **設定**（`src/config.ts`）: 上限値は `defaults` に定義する。Worker の vars で上書きできるのは `MAX_VIDEO_DURATION_SECONDS` と `UPLOAD_URL_TTL_SECONDS` の 2 つだけで、不正な値ならデフォルトに戻る。制限値はツールの description にも埋め込まれている。
- **認証**（`src/auth.ts`）には任意の 2 層があり、両方設定されていれば両方を要求する。1 つは `SEEKIO_AUTH_TOKEN`（Bearer、タイミングセーフ比較）。もう 1 つは `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` による Cloudflare Access JWT の RS256 検証で、certs は 5 分キャッシュし、未知の kid による強制再取得は最短 60 秒間隔に制限する。
- **ログ**（`src/log.ts`）: 型付きのイベント名で 1 行 JSON を出力する。トークン、upload URL、Authorization ヘッダー、フレームのバイト列は絶対にログに出さない。
- **サーバー instructions**（`src/mcp/instructions.ts`）: エージェントに段階的な調査パターンを促す文面。ツールの振る舞いを変えたときはここと README の Tool reference も合わせて更新する。
- **Portal スクリプト**（`scripts/portal.ts` + `scripts/portal-lib.ts`）: Cloudflare API 経由で MCP Server Portal に冪等に登録する。純粋ロジックは `portal-lib.ts` に分け、unit テストの対象にしている。Worker のデプロイとは独立している。

## テストの構成

- ツールのテストは、`test/unit/mcp-harness.ts` が SDK の `createMcpHandler` を通して実際の MCP サーバーに JSON-RPC を送る形で行う。ネットワークもクライアントパッケージも使わない。バックエンドには `test/unit/fake-backend.ts` の `FakeVideoBackend` を使う（インメモリで、呼び出し履歴を `calls` に記録する）。Stream API を使わずにツールの大半をテストできる。
- `test/unit/worker.test.ts` は `src/index.ts` の default export を直接呼び、ルーティングと認証を検証する。

## コード規約

- TypeScript は strict に加えて `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax` を有効にしている。型だけの import には `import type` を使う。optional プロパティに `undefined` を代入せず、プロパティ自体を省略する（例: `...(cond && { key })`）。
- Biome のフォーマット設定: スペース 2、行幅 100、ダブルクォート、セミコロンあり。
- MCP の入力スキーマは zod（v4）で書き、フィールド名は snake_case にする（`video_id`, `max_frames` など）。
