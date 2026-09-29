# Seekio 詳細設計書

**Status:** v1 implementation-ready\
**Name:** Seekio\
**Meaning:** Seek + I/O\
**Tagline:** Video I/O for AI agents.

## 1. 目的

Seekio は AI Coding Agent に動画の時間軸を探索するための視覚 I/O
を提供する Remote MCP Server
である。主用途はフロントエンドデバッグとする。

ユーザーが画面録画を用意して「3秒くらいで drawer
が一瞬左に飛ぶ。原因を調べて直して」のように指示すると、Agent は Seekio
で動画全体を粗く確認し、異常区間を絞り、必要な範囲だけ高い時間解像度で確認する。

Seekio 自身は動画を理解しない。

``` text
Video
  ↓
Seekio
  ↓ timestamped image frames
Coding Agent
  ↓ vision + reasoning
Repository investigation / fix
```

> **Seekio does not understand video. It lets AI agents understand
> video.**

## 2. v1 完成条件

途中の vertical slice ではリリースせず、最初から以下の6 toolsを揃える（その後 `video_import_url` を追加し、その後 `video_transcript` を追加し、現在は8 tools）。

``` text
video_create_upload
video_import_url
video_info
video_overview
video_frames
video_frame
video_delete
```

加えて以下を満たす。

-   Cloudflare Workers 上で stateless Remote MCP Server として動作
-   Cloudflare Stream への direct upload
-   動画全体 overview
-   指定区間の複数 frame 取得
-   指定時刻の exact frame 取得
-   動画削除
-   progressive temporal inspection を促す MCP server instructions
-   frame 数などの安全制限
-   GitHub Actions による CI
-   Cloudflare Workers の GitHub 連携による CD
-   mise をローカル操作の canonical entrypoint にする
-   MCP Server Portal 連携は optional。mise task から設定

## 3. v1 非目標

``` text
R2 video storage
ffmpeg runtime
VLM inference
SAM / segmentation
OCR
STT / Whisper
video summarization
scene detection
object tracking
automatic bug detection
Playwright
browser automation
contact sheet generation
Skill
Durable Objects
D1
KV
application database
```

必要性が実利用で確認されるまで追加しない。

`STT / Whisper` は「Seekio 自身が音声認識を実行しない」という意味である。
Cloudflare Stream の AI 字幕生成を Workers binding 経由で呼ぶことは、
Cloudflare Images の切り出しを呼ぶのと同じ扱い（外部サービスの機能を呼ぶだけ）
とし、非目標には反しない（§13.8）。

## 4. システム構成

### 4.1 Standalone

``` text
Claude Code / Codex / MCP Client
              │
              │ Streamable HTTP
              ▼
┌──────────────────────────────┐
│ Seekio Worker                │
│ /mcp                         │
│                              │
│ video_create_upload          │
│ video_import_url             │
│ video_info                   │
│ video_overview               │
│ video_frames                 │
│ video_frame                  │
│ video_delete                 │
│                              │
│ scheduled (Cron, 毎時)       │
│  └ 期限切れ動画の削除        │
└──────────────┬───────────────┘
               │ Stream Binding
               ▼
┌──────────────────────────────┐
│ Cloudflare Stream            │
│ upload / store / encode      │
│ metadata / thumbnails/delete │
└──────────────────────────────┘
```

### 4.2 Optional MCP Server Portal

``` text
Claude Code / Codex
        ↓
Cloudflare MCP Server Portal
        ↓
Seekio /mcp
        ↓
Cloudflare Stream
```

Portal は必須コンポーネントにしない。Seekio 本体は Portal
の存在を認識せず、Portal 有無でコードパスを分岐しない。

Portal 側の責務は Access、server/tool policy、tool alias/description
override、context optimization / Code Mode、必要に応じた Gateway/DLP
とする。

## 5. 技術スタック

``` text
Language          TypeScript
Runtime           Cloudflare Workers
MCP SDK           @modelcontextprotocol/server
Cloudflare MCP    agents
Validation        Zod
Video             Cloudflare Stream
Package Manager   pnpm
Runtime Manager   mise
Worker CLI        Wrangler
Test              Vitest
Lint / Format     Biome
CI                GitHub Actions
CD                Cloudflare Workers GitHub integration
```

Node.js は開発ツール用。本番 runtime は Cloudflare Workers。

新規 MCP Server は stateless とし `createMcpHandler()`
を使用する。deprecated な `McpAgent` / Durable Objects ベースの stateful
MCP Server は使用しない。

## 6. リポジトリ構成

``` text
seekio/
├── .github/
│   └── workflows/
│       └── ci.yml
├── scripts/
│   └── portal.ts
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── mcp/
│   │   ├── server.ts
│   │   ├── instructions.ts
│   │   ├── errors.ts
│   │   └── tools/
│   │       ├── create-upload.ts
│   │       ├── info.ts
│   │       ├── overview.ts
│   │       ├── frames.ts
│   │       ├── frame.ts
│   │       └── delete.ts
│   └── video/
│       ├── backend.ts
│       ├── cloudflare-stream.ts
│       ├── frame.ts
│       └── timestamps.ts
├── test/
│   ├── unit/
│   └── integration/
├── biome.json
├── mise.toml
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vitest.config.ts
├── wrangler.jsonc
├── README.md
└── LICENSE
```

単一 package。v1 は monorepo にしない。

## 7. Worker / MCP endpoint

基本 endpoint:

``` text
GET  /health
POST /mcp
```

MCP transport は `createMcpHandler()`
に委譲する。実装時にはインストールした Agents SDK / MCP SDK の現行 API
signature を正とする。

Server metadata:

``` text
name: seekio
version: package.json version
```

## 8. MCP Server Instructions

``` text
Seekio provides temporal visual I/O for videos.

Use Seekio when you need to inspect visual behavior that changes over time.

For an unfamiliar video:

1. Call video_info.
2. Call video_overview to inspect the whole timeline.
3. Identify relevant or suspicious time ranges.
4. Use video_frames to inspect those ranges at a higher temporal resolution.
5. Narrow the range progressively when necessary.
6. Use video_frame for precise inspection.

For frontend debugging, look for:
- layout shifts
- flickering
- transient rendering states
- animation and transition problems
- loading states
- unexpected overlays
- navigation changes
- incorrect interaction feedback

Do not request high FPS across an entire video.

Prefer progressive temporal inspection:

whole video
-> suspicious range
-> higher-FPS range
-> exact frame
```

別 Skill は v1 では作らない。

## 9. VideoBackend

Cloudflare Stream 依存を1箇所に閉じ込める。

``` ts
export interface VideoBackend {
  createUpload(input: CreateUploadInput): Promise<Upload>;
  importFromUrl(input: ImportUrlInput): Promise<ImportedVideo>;
  getInfo(videoId: string): Promise<VideoInfo>;
  getFrame(videoId: string, timestamp: number): Promise<Frame>;
  delete(videoId: string): Promise<void>;
}
```

主要型:

``` ts
export type CreateUploadInput = {
  filename?: string;
  maxDurationSeconds?: number;
};

export type Upload = {
  videoId: string;
  uploadUrl: string;
  expiresAt?: string;
};

export type VideoInfo = {
  id: string;
  status:
    | "pendingupload"
    | "downloading"
    | "queued"
    | "inprogress"
    | "ready"
    | "error";
  duration?: number;
  width?: number;
  height?: number;
  createdAt?: string;
};

export type Frame = {
  timestamp: number;
  mimeType: "image/jpeg";
  data: ArrayBuffer;
};
```

v1 実装は `CloudflareStreamBackend` のみ。factory/repository/provider
registry は作らない。

## 10. Cloudflare Stream

動画保存先は Cloudflare Stream。R2 と Workers 一時 filesystem
は使わない。

Stream に以下を担当させる。

``` text
upload
storage
encoding
metadata
timestamp thumbnail generation
deletion
```

`wrangler.jsonc` に Stream binding を設定する。

``` json
{
  "name": "seekio",
  "main": "src/index.ts",
  "compatibility_date": "<current>",
  "stream": {
    "binding": "STREAM"
  }
}
```

可能な限り Workers Stream Binding を使う。

``` ts
env.STREAM.createDirectUpload(...)
env.STREAM.video(id).details()
env.STREAM.video(id).generateToken()
env.STREAM.video(id).delete()
```

### 10.0 Cloudflare Stream の AI 字幕（`video_transcript`）

`video_transcript`（§13.8）のために、Stream binding の字幕 API を使う。

``` ts
env.STREAM.video(id).captions.list()
env.STREAM.video(id).captions.generate(lang)
```

本文（WebVTT）は binding からは取れない（`StreamCaption` は
`{ language, label, generated?, status? }` で本文を持たない）。サムネイルと同じ
オリジンに、署名トークンを付けて GET する。

``` text
https://<thumbnail と同じオリジン>/<署名トークン>/captions/<lang>   -> text/vtt
```

`.vtt` や `/vtt` を付けると 404、トークンの位置に動画 ID を入れると 401 になる。
トークンは `generateToken()` の値（`thumbnailSource` の base と同じ）をそのまま使う。

実サービスで確認した挙動:

- 対応言語は 12: cs, nl, en, fr, de, it, ja, ko, pl, pt, ru, es。自動判定はなく、
  言語の指定が必須。`en-US` のような派生形は `en` とは別の字幕として作られてしまうため、
  Seekio は受け付けない。
- 1 本の動画に複数言語の字幕を作れる。同じ言語の 2 回目の generate は
  `BadRequestError`（"There is an existing caption for this language..."）になる。
  Seekio はこれを成功扱いにして状態を見に行く。
- 日本語と英語が混ざった動画では、指定した言語の部分しか信頼できない。他の言語の部分は
  幻覚（「ご視聴ありがとうございました」など）や誤訳になる。
- 生成は非同期（inprogress -> ready / error）。180 秒の動画で ja が約 11 秒、en が約 7 秒。
- VTT のタイムスタンプはミリ秒精度。cue は句や文の単位で、発話開始とのずれは概ね ±0.5 秒。
  1 文が複数の cue に割れたり、長さ 0 の cue が出たりする。
- binding のエラー（リモート binding では message の先頭に種類が付く）:
  `StreamBindingError: Missing Audio`（音声なし）、`StreamBindingError: Language not
  supported`、`BadRequestError`（不正な言語 / 既存の字幕）、`NotFoundError`（動画なし）。

採用の理由:

- テスターから「音声は見られない。ナレーション付きの動画で、字幕と声がずれていないかを
  確かめられなかった」という声があり、実利用で必要性が確認された。
  ユーザーからは「文字起こしは日本語にも英語にも柔軟に対応できる必要がある」との要望もあった。
- Seekio は音声認識を実装しない。Stream の機能を呼び、結果を時刻付きで返すだけ。
  R2・ffmpeg・DB などの追加は不要で、動画の保存とエンコードは引き続き Stream が担当する。
- 料金: 2024 年の Cloudflare 公式ブログ（Stream の AI 字幕生成の発表）に「追加料金なし」
  とある。現行の料金ページには字幕生成の記載がない。確認できている根拠はこのブログのみで、
  将来課金される可能性は残る。

### 10.1 Cloudflare Images binding（region 切り出し）

`video_frame` の `region`（指定範囲の切り出し）のために、Cloudflare Images の
Workers binding（`env.IMAGES`）を新しい依存として採用する。

採用理由:

``` text
- 実利用で、全体フレーム（720p に縮小）では下端のクレジットなど小さい文字が読めず、
  元の解像度から範囲を切り出す手段が必要と確認された
- Stream のサムネイルは任意の矩形で切り出せない（time / height / width / fit のみ）
- 解像度の上限を上げるだけでは不十分（モデル側で長辺約 1.5k px に縮められる）
```

§3 の非目標（R2 / ffmpeg / VLM / OCR など）とは矛盾しない。Seekio は画像を
理解せず、切り出した JPEG を返すだけである。動画の保存は引き続き Stream が担う。

``` json
{ "images": { "binding": "IMAGES" } }
```

- 切り出しは `VideoBackend` とは別の境界 `ImageCropper`（`src/video/image.ts`）に置く
- `env.IMAGES` が無い環境では cropper を作らず、`region` 指定は `REGION_UNAVAILABLE`
- 変換失敗（無料枠 月 5,000 ユニーク変換の超過を含む）は `REGION_CROP_FAILED`。
  超過時の挙動は未確認のため、エラー文字列に依存した分岐は作らない
- 結果の長辺は `regionMaxLongEdge`（1568px）まで。超える場合だけ縮小し、拡大はしない

## 11. Upload 設計

動画 bytes を Worker 経由にしない。

``` text
MCP Client
   │ video_create_upload
   ▼
Seekio
   │ one-time URL
   ▼
MCP Client ───── video bytes ─────> Stream
```

標準 upload は Stream Binding の `createDirectUpload()`。

v1 は **200 MB 以下**に限定する。200 MB 超は tus が必要になるため
unsupported とし、必要性が出たら追加する。

デフォルト:

``` text
UPLOAD_URL_TTL_SECONDS       = 900
MAX_VIDEO_DURATION_SECONDS   = 300
MAX_UPLOAD_BYTES             = 209715200
```

5分上限は frontend debugging 用の初期値。設定で変更可能にする。

## 12. Frame extraction

Cloudflare Stream の on-demand thumbnail を使う。

概念:

``` text
.../thumbnails/thumbnail.jpg?time=3.347s&height=720&fit=scale
```

Seekio が JPEG を fetch し、MCP `image` content として返す。

デフォルト:

``` text
FRAME_HEIGHT = 720（ソース動画の高さがこれ未満ならソース高さ。アップスケールしない）
```

Stream video は原則 `requireSignedURLs = true` で作成する。frame fetch
時に Stream Binding の `generateToken()` を使い、raw video UID
だけで画像へアクセスできる状態を避ける。

## 13. MCP Tools

### 13.1 `video_create_upload`

Input:

``` ts
{
  filename?: string;
  max_duration_seconds?: number;
}
```

Output:

``` json
{
  "video_id": "abc123",
  "upload_url": "...",
  "expires_at": "...",
  "max_duration_seconds": 300,
  "max_upload_bytes": 209715200
}
```

作成時:

``` text
requireSignedURLs = true
expiry = now + 15 minutes
meta.filename = filename
meta.application = seekio
```

### 13.2 `video_info`

Input:

``` ts
{ video_id: string }
```

Output:

``` json
{
  "id": "abc123",
  "status": "ready",
  "duration": 14.82,
  "width": 1179,
  "height": 2556,
  "ready": true
}
```

`ready` 以外では frame 系 tool を実行しない。

処理中:

``` text
Video is still processing.
Call video_info again before requesting frames.
```

### 13.3 `video_overview`

Input:

``` ts
{
  video_id: string;
  max_frames?: number;
  interval_seconds?: number;
}
```

default:

``` text
max_frames = 12
```

`interval_seconds` 未指定なら duration から均等配置。

``` text
t[i] = i * D / (N - 1)
```

最終 timestamp は `D - 0.001` 以下へ clamp。短い動画で発生した重複
timestamp は除去する。

Response は timestamp の text と複数の image content。contact sheet
は生成しない。

### 13.4 `video_frames`

Input:

``` ts
{
  video_id: string;
  start: number;
  end: number;
  fps?: number;
}
```

defaults/limits:

``` text
DEFAULT_FPS          = 5
MAX_FPS              = 30
MAX_FRAMES_PER_CALL  = 15
```

validation:

``` text
start >= 0
end > start
end <= duration
fps > 0
fps <= 30
frame_count <= 15
```

timestamp は浮動小数点累積を避ける。

``` ts
timestamp = start + index / fps;
```

上限超過時に自動で fps を落とさない。

``` text
Requested 16 frames, but Seekio allows at most 15 frames per call.
Narrow the interval or reduce fps.
```

### 13.5 `video_frame`

Input:

``` ts
{
  video_id: string;
  at: number;
  region?: { x: number; y: number; width: number; height: number };
}
```

validation:

``` text
0 <= at < duration
region: 各値 0..1、width/height > 0、x+width <= 1、y+height <= 1
        （左上が原点。x=左端、y=上端。違反は INVALID_REGION）
```

Response:

``` text
Frame at 3.347s
<image/jpeg>
```

`region` 指定時は、ソース解像度のフレームから矩形を切り出して返す（§10.1）。

``` text
Frame at 3.347s, region x=0 y=0.8 w=1 h=0.2 (1568x176 px)
<image/jpeg>
```

### 13.6 `video_delete`

Input:

``` ts
{ video_id: string }
```

Output:

``` json
{
  "video_id": "abc123",
  "deleted": true
}
```

利用者視点では idempotent
に近い動作にする。既に削除済みなら成功扱いにしてよい。

### 13.8 `video_transcript`

動画の発話を、時刻付きのテキスト（cue）として返す。音声の再生・波形・音の解析は扱わない。
Stream の AI 字幕生成の結果を返すだけ。

Input:

``` ts
{
  video_id: string;
  languages: Array<"cs"|"nl"|"en"|"fr"|"de"|"it"|"ja"|"ko"|"pl"|"pt"|"ru"|"es">; // 1-3、重複不可
  start?: number;         // 秒。既定 0
  end?: number;           // 秒。start < end <= duration。既定 duration
  wait_seconds?: number;  // 0-25。video_info と同じ待ち方
}
```

処理:

1. `requireReady` で ready と duration を確かめる。
2. `captions.list()` で状態を見て、無い言語だけ `generate` する（既存は成功扱い）。
3. 全言語が ready / error になるか、`wait_seconds` が切れるまで待つ。
4. ready の言語は VTT を取得してパース（`src/video/vtt.ts`）し、範囲と重なる cue を返す。

Output:

``` json
{
  "video_id": "abc123",
  "transcripts": [
    { "language": "ja", "status": "ready", "cues": [{ "start": 1.24, "end": 3.9, "text": "..." }] },
    { "language": "en", "status": "inprogress" }
  ],
  "note": "... call video_transcript again with wait_seconds ..."
}
```

- `start` / `end` は秒（ミリ秒精度）。`video_frame` の `at` とそのまま比べられる。
- 長さ 0 の cue と空の cue は落とし、テキストの前後の空白は整える。
- `status: "error"` の言語には `message` が付く。全言語が error なら `TRANSCRIPT_FAILED`。
- 言語の自動判定はない。話されている言語を指定する。混在や不明のときは候補をまとめて
  指定する（例: `["ja","en"]`）。各言語の結果は、その言語が話されている区間でしか信頼できない。
- 時刻のずれはおおむね ±0.5 秒。

エラー: `NO_AUDIO_TRACK`（音声がない）、`UNSUPPORTED_LANGUAGE`（対応言語の一覧を案内）、
`TRANSCRIPT_FAILED`（生成が error / 本文を取得できない）。いずれもプロバイダー由来として
`backend.error` ログの対象にする。

字幕と声のずれの確認手順: `video_transcript` で発話の時刻を得る -> その前後を
`video_frames` で見て、画面の字幕と照らし合わせる（server instructions に記載）。

### 13.7 `video_import_url`

公開されている動画ファイルの URL を Cloudflare Stream に取り込む。
YouTube 等のページ URL は対象外。

Input:

``` ts
{
  url: string;       // http / https のみ
  filename?: string; // 1〜255 文字、metadata
}
```

Output:

``` json
{ "video_id": "abc123", "status": "downloading" }
```

取り込みは Stream Binding の `env.STREAM.upload(url, params)` で行う。
取り込みは非同期なので、agent は `video_info` が `ready` になるまでポーリングする。

作成時:

``` text
requireSignedURLs = true
meta.filename = filename
meta.application = seekio
```

`StreamUrlUploadParams` には `maxDurationSeconds` も expiry も無いため、
duration 上限は事前に強制できない。ready になった後、frame 系 tool が
`requireReady` で検査し、上限超過なら `VIDEO_TOO_LONG` を返す（自動削除はしない）。
Worker からの HEAD 事前チェックは行わない。

URL には署名付きクエリが含まれうるため、URL はログに出さない
（`upload.imported` は `video_id` と `duration_ms` のみ）。

## 14. MCP image response

URL を返すのではなく、Seekio が JPEG を取得して MCP image content
にする。

``` ts
{
  type: "image",
  data: base64,
  mimeType: "image/jpeg"
}
```

複数 frame は timestamp と image の順序を維持する。

``` text
timestamp
image
timestamp
image
...
```

これにより MCP client に Stream URL fetch 能力を要求せず、backend
変更でも MCP contract を維持できる。

## 15. Concurrency

overview / frames の画像取得は逐次にしない。一方、無制限 `Promise.all`
もしない。

``` text
FRAME_FETCH_CONCURRENCY = 6
```

程度の bounded concurrency を実装する。最大15 framesなので queue
infrastructure は不要。

## 16. Error model

``` ts
type SeekioErrorCode =
  | "VIDEO_NOT_FOUND"
  | "VIDEO_NOT_READY"
  | "VIDEO_PROCESSING_FAILED"
  | "INVALID_TIMESTAMP"
  | "INVALID_INTERVAL"
  | "TOO_MANY_FRAMES"
  | "VIDEO_TOO_LONG"
  | "INVALID_URL"
  | "URL_ALREADY_IMPORTED"
  | "UPLOAD_CREATE_FAILED"
  | "FRAME_FETCH_FAILED"
  | "NO_AUDIO_TRACK"
  | "UNSUPPORTED_LANGUAGE"
  | "TRANSCRIPT_FAILED"
  | "BACKEND_ERROR";
```

Agent が次の行動を判断できる message を返す。

`video_import_url` 由来のコード:

| code | 条件 | 案内 |
| --- | --- | --- |
| `INVALID_URL` | Stream が `BadRequestError` を返した | 公開されていて直接ダウンロードできる動画ファイルの URL か確認する |
| `URL_ALREADY_IMPORTED` | Stream が `AlreadyUploadedError` を返した | 既存の動画を使う、または `video_delete` で消してから再取り込みする（削除後の再取り込み可否は保証しない） |
| `UPLOAD_CREATE_FAILED` | `MaxFileSizeError` / `QuotaReachedError` / `RateLimitedError` / その他 | 原因に応じた文面 |
| `VIDEO_TOO_LONG` | frame 系 tool で `duration` が上限（既定 300 秒）を超える | `video_delete` で削除し、短い動画を使う |

`VIDEO_TOO_LONG` は `requireReady` で検査するため、直接アップロードの動画にも適用される。
プロバイダー由来として `backend.error` ログの対象にするのは `UPLOAD_CREATE_FAILED` などで、実装は `BACKEND_ERROR_CODES` を参照する。

### 16.1 フレーム取得の 404 再試行

Stream は、動画が ready になった後もしばらく（最大で約 1〜2 分）サムネイルの取得が不安定になり、
時刻や高さに関係なく HTTP 404 が断続的に出ることがある（pct_complete が 100 でも起きる。
エッジのキャッシュではない）。そこで `CloudflareStreamBackend.getFrame` は、404 のときだけ
同じ時刻で指数バックオフ（1s, 2s, 4s）の再試行を行う。

| 呼び出し | 404 の再試行 |
| --- | --- |
| `video_frame` | 最大 3 回（1s, 2s, 4s） |
| `video_frames` / `video_overview` | 1 コマあたり最大 1 回（1s） |

上限値は `defaults`（`frameRetrySingleMax` / `frameRetryMultiMax` / `frameRetryBaseDelayMs`）。
Workers のサブリクエスト数の上限（無料プランは 50）を意識し、複数コマの再試行は 1 回にしている。
既存の「末尾 1 秒以内の 4xx で手前の時刻にずらす再試行」は残す。両者の順序は、
同じ時刻の 404 再試行 -> 手前の時刻（各 1 回）で、手前の時刻では 404 の再試行をしない。
映像トラックがコンテナの duration より短い動画では、映像が終わった後の時刻が HTTP 400 になる。

再試行しても失敗したときの `FRAME_FETCH_FAILED` の案内:

- 404: ready 直後は Stream 側で取得が数分不安定になることがある。30〜60 秒待って同じ呼び出しをやり直すか、`at` を 0.1 秒ずらす。
- 400 で動画の末尾付近: 映像トラックが動画の長さより早く終わっている可能性がある。もっと前の時刻を試す。

`video_info` の `ready`（フレームを取れる状態）と `pct_complete`（全画質の変換の進み具合。
ready の時点で 100 未満のことがある）は別物。`ready` の判定は変えない。

## 17. Security

-   Stream upload は `requireSignedURLs = true`
-   Stream credential/token/upload URL を log しない
-   `video_id` は secret とみなさない
-   Seekio core を特定 IdP / Portal に密結合させない
-   `/mcp` のアクセス制御は deployment environment で Cloudflare Access
    等を追加可能にする
-   v1 を単一 trust domain の内部ツールとして運用するなら ownership DB
    を追加しない
-   multi-tenant 化する場合は `creator` / principal による ownership
    validation を追加する

## 18. Retention

Seekio は動画ライブラリではない。動画は temporary artifact。

v1 は明示的な `video_delete` を提供する。

Stream の `scheduledDeletion` はアップロードから30日以上先しか指定できない
ため、短時間 TTL には使えない。自動削除は Worker の Cron Trigger で行う。

-   `wrangler.jsonc` の `triggers.crons`（`0 * * * *`、毎時）で `scheduled`
    ハンドラーを起動する
-   `VideoBackend.listVideos()` が Stream の `meta.application === "seekio"`
    の動画だけを返す（同じアカウントの他の動画は絶対に消さない）。一覧は
    `videos.list` の `before`（`lte`）でページングする
-   `deleteExpiredVideos(backend, now, retentionHours)`（`src/video/cleanup.ts`）が、
    `createdAt` が `now - retentionHours` より古い動画だけを `delete` する。
    ちょうど境界の動画と `createdAt` を解釈できない動画は消さない。1件の失敗で
    全体を止めない
-   保持時間は `VIDEO_RETENTION_HOURS`（既定 24）。毎時実行なので、最大で約1時間
    遅れて消える
-   保険として、作成時に `scheduledDeletion`（作成から31日後）も付ける。
    Cron が動かなくても Stream 側で消える
-   ログは `cleanup.completed`（scanned / deleted / failed / duration_ms）のみ。
    動画 ID や URL は出さない
-   出力: `video_create_upload` / `video_import_url` は
    `auto_delete_after_hours`、`video_info` は `delete_after` を返す

DB / KV / Durable Objects は追加しない（Stream の metadata と作成時刻だけで
判断できる）。

## 19. Observability

Workers 標準 logging + structured log。

例:

``` json
{
  "event": "frames.requested",
  "video_id": "...",
  "start": 3.2,
  "end": 3.6,
  "fps": 20,
  "frames": 9,
  "duration_ms": 842
}
```

記録しない:

``` text
video/frame binary
signed token
upload URL
API token
authorization header
```

event:

``` text
upload.created
video.info
overview.requested
frames.requested
frame.requested
video.deleted
backend.error
```

## 20. Configuration

`src/config.ts` に集約する。

``` ts
export const defaults = {
  maxVideoDurationSeconds: 300,
  uploadUrlTtlSeconds: 900,
  maxFramesPerCall: 15,
  defaultFramesFps: 5,
  maxFps: 30,
  overviewMaxFrames: 12,
  frameHeight: 720,
  frameFetchConcurrency: 6,
  videoRetentionHours: 24, // Cron cleanup の保持時間（VIDEO_RETENTION_HOURS で上書き）
} as const;
```

magic number を各 tool に散らさない。

## 21. mise

mise を canonical entrypoint にする。

``` toml
[tools]
node = "24"
pnpm = "latest"

[tasks.install]
description = "Install dependencies"
run = "pnpm install --frozen-lockfile"

[tasks.dev]
description = "Run Seekio locally"
run = "pnpm wrangler dev"

[tasks.typecheck]
description = "Type check"
run = "pnpm tsc --noEmit"

[tasks.lint]
description = "Lint and format check"
run = "pnpm biome check ."

[tasks.test]
description = "Run tests"
run = "pnpm vitest run"

[tasks.check]
description = "Run all CI checks"
depends = ["typecheck", "lint", "test"]

[tasks.deploy]
description = "Deploy Seekio Worker"
depends = ["check"]
run = "pnpm wrangler deploy"

[tasks.portal]
description = "Register/update Seekio in Cloudflare MCP Server Portal"
run = "pnpm tsx scripts/portal.ts"

[tasks."portal:dry-run"]
description = "Show MCP Server Portal changes without applying"
run = "pnpm tsx scripts/portal.ts --dry-run"
```

通常の `install/dev/check/deploy` に Portal 操作を含めない。

## 22. Optional MCP Server Portal integration

Portal configuration は Worker deploy と分離する。

``` text
mise run deploy
  -> Seekio Worker only

mise run portal
  -> register/update existing Seekio in MCP Server Portal
```

Portal task 専用 environment:

``` text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
SEEKIO_MCP_URL
SEEKIO_PORTAL_ID
SEEKIO_PORTAL_SERVER_ID=seekio
SEEKIO_PORTAL_AUTH (optional: oauth | bearer | unauthenticated)
```

`SEEKIO_PORTAL_AUTH` 未指定時は `SEEKIO_AUTH_TOKEN` があれば bearer、なければ
unauthenticated。`bearer` は `SEEKIO_AUTH_TOKEN` 必須、`oauth` はトークンを送らない。
Cloudflare Access（Managed OAuth）で保護した Worker は `oauth` で登録する。

`scripts/portal.ts` の責務:

1.  environment validation
2.  Seekio `/mcp` URL validation
3.  current Portal config fetch
4.  Seekio server lookup
5.  create if absent
6.  portal mapping create/update
7.  6 tools expose
8.  diff表示
9.  `--dry-run` なら変更しない

script は idempotent にする。

``` text
mise run portal
mise run portal
```

で重複 server/mapping を作らない。

Portal 側では v1 の6 toolsをすべて expose。alias は設定せず、Seekio
本体の tool name / description を canonical とする。

Portal の Code Mode/context optimization は運用側の選択。Seekio 自身には
Code Mode を実装しない。

## 23. GitHub Actions CI

`.github/workflows/ci.yml`

trigger:

``` yaml
on:
  pull_request:
  push:
    branches:
      - main
```

処理:

``` text
checkout
setup mise
mise run install
mise run check
```

PR では deploy しない。branch protection では CI job を required check
にすることを推奨。

## 24. Workers GitHub CD

本番 CD は Cloudflare Workers の GitHub integration / Workers Builds
を使う。

``` text
main push
  ↓
Workers Builds
  ↓
build/check
  ↓
wrangler deploy
```

役割:

``` text
GitHub Actions = test / typecheck / lint
Workers Builds = production deploy
```

GitHub Actions に Worker deployment credential を持たせる必要を減らす。

Workers Builds の deploy command:

``` text
pnpm wrangler deploy
```

ローカル手動 deploy の canonical command:

``` text
mise run deploy
```

## 25. package scripts

``` json
{
  "scripts": {
    "dev": "wrangler dev",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "vitest run",
    "check": "pnpm typecheck && pnpm lint && pnpm test",
    "deploy": "wrangler deploy"
  }
}
```

依存 version は `package.json` + lockfile で固定する。

## 26. Tests

Unit:

``` text
overview timestamp calculation
frame timestamp calculation
duration edge
end-of-video clamp
duplicate timestamp removal
default fps
MAX_FPS
MAX_FRAMES_PER_CALL
invalid start/end
error mapping
```

`VideoBackend` の fake を作り、tool の大半は Stream API なしで test。

実 Stream integration は通常 CI と分離し、必要なら:

``` text
mise run test:integration
```

を追加する。

scenario:

``` text
create upload
-> upload fixture
-> poll info until ready
-> overview
-> frames
-> frame
-> delete
```

最重要 E2E:

``` text
Claude Code / Codex
  -> Seekio
  -> multiple MCP image contents
```

Agent が複数画像を timestamp 順に比較できること。

Portal 利用時は追加で:

``` text
Agent
-> MCP Server Portal
-> Seekio
-> Stream
-> image
-> Agent
```

を確認する。

## 27. README

最低限:

``` text
What is Seekio?
Architecture
Requirements
Cloudflare Stream setup
Local development
Deploy
MCP client configuration
Tool reference
Example debugging workflow
Limits
Optional MCP Server Portal integration
Security
License
```

冒頭:

``` markdown
# Seekio

Video I/O for AI agents.

Seekio is a Remote MCP server that lets AI agents progressively
inspect video timelines as timestamped image frames.
```

## 28. 実装順序

``` text
1. project bootstrap
2. Stream binding
3. VideoBackend
4. video_info
5. video_frame
6. video_create_upload
7. video_overview
8. video_frames
9. video_delete
10. MCP instructions
11. limits / errors
12. unit tests
13. real Stream integration test
14. GitHub Actions
15. Workers GitHub integration
16. README
17. optional portal task
18. Claude Code / Codex E2E
```

4〜5 は architecture validation として使うが、そこでリリースしない。v1
release は6 toolsが揃った状態のみ。

## 29. Acceptance Criteria

### Upload

-   one-time Stream upload URL を取得できる
-   video bytes が Worker を経由しない
-   upload URL が短時間で失効
-   signed URL required video として作成

### Info

-   encoding status を取得
-   ready 前の frame request を明確に拒否
-   duration / width / height を取得

### Overview

-   動画全体から最大12 frames
-   timestamp が均等分散
-   image と timestamp の対応が保持される

### Frames

-   start/end/fps から deterministic に timestamp 計算
-   最大15 frames
-   上限超過時は自動縮退せず actionable error

### Frame

-   sub-second timestamp
-   JPEG を MCP image content として返却

### Delete

-   Stream video 削除
-   repeated delete が安全

### Infrastructure

以下が成立:

``` text
mise run dev
mise run check
mise run deploy
```

さらに:

-   PR/main push で GitHub Actions CI
-   main production deployment は Workers GitHub integration
-   Portal なしで Seekio が動作
-   Portal 利用時は `mise run portal` で登録・更新

## 30. 将来拡張

実利用を見て判断する。

``` text
automatic TTL cleanup
tus >200 MB upload
before/after video comparison
scene change detection
animated preview
contact sheet
audio extraction
STT
Playwright integration
frontend-debug Skill
multi-tenant ownership
usage quotas
R2 backend
local backend
```

R2 は Cloudflare Stream をやめる理由が発生した場合の backend
候補であり、v1 構成要素ではない。

## 31. 最終的な責務境界

Seekio:

``` text
upload
video lifecycle
metadata
timeline navigation
frame extraction
MCP transport
```

Coding Agent:

``` text
visual interpretation
temporal reasoning
bug diagnosis
repository investigation
code modification
verification
```

この境界を維持し、Seekio に AI reasoning を持ち込まない。
