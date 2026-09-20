export const instructions = `Seekio provides temporal visual I/O for videos.

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
-> exact frame`;
