export const instructions = `Seekio provides temporal visual I/O for videos.

Use Seekio when you need to inspect visual behavior that changes over time.

To get a video into Seekio:

- If you have a local file, call video_create_upload and upload the bytes to the returned upload_url.
- If the video is a public direct file URL (for example https://example.com/foo.mp4), call video_import_url. Web pages such as YouTube are not supported.
- Either way, poll video_info until it is ready, and call video_delete when you are done.

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
-> exact frame`;
