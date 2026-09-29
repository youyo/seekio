import { defaults } from "../config";

/** Server instructions; `retentionHours` is the configured automatic-deletion window. */
export const buildInstructions = (
  retentionHours: number,
) => `Seekio provides temporal visual I/O for videos.

Use Seekio when you need to inspect visual behavior that changes over time.

To get a video into Seekio:

- If you have a local file, call video_create_upload, replace <PATH> in the returned upload_command with the local file path and run it in a shell (the server cannot read your files, so this upload step is required).
- If the video is a public direct file URL (for example https://example.com/foo.mp4), call video_import_url. Web pages such as YouTube are not supported.
- Either way, call video_info with wait_seconds (for example 25) to wait until it is ready, repeating if it is still processing, and call video_delete when you are done.

Videos are stored temporarily in the Cloudflare account and are deleted automatically about ${retentionHours} hours after creation (the cleanup runs hourly, so up to about an hour later). Call video_delete as soon as you are done to remove them immediately; do not upload material that must not be stored outside your machine.

For an unfamiliar video:

1. Call video_info.
2. Call video_overview to inspect the whole timeline.
3. Identify relevant or suspicious time ranges.
4. Use video_frames to inspect those ranges at a higher temporal resolution.
5. Narrow the range progressively when necessary.
6. Use video_frame for precise inspection. To read small text in that frame, pass region to crop the area from the original-resolution frame.

When you already know the time to inspect (for example the on-screen text or credits at a specific second):

1. Call video_info (with wait_seconds if needed) and confirm it is ready.
2. Skip video_overview and call video_frame(at) for that exact moment, or video_frames with a narrow start/end range around it.
3. Whole frames are downscaled, so small text (credits, captions, fine print) may be unreadable. To read it, call video_frame(at, region) with region = { x, y, width, height } as ratios (0-1) of the frame, origin at the top-left (x = left edge, y = top edge). For example the bottom credits are { x: 0, y: 0.8, width: 1, height: 0.2 }. The crop comes from the original-resolution frame.

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
-> exact frame (with region to read fine details)`;

export const instructions = buildInstructions(defaults.videoRetentionHours);
