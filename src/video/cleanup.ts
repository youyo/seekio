import type { VideoBackend } from "./backend";

export type CleanupResult = {
  /** Videos Seekio created that were listed. */
  scanned: number;
  deleted: number;
  failed: number;
};

/**
 * Deletes Seekio videos created more than `retentionHours` before `now` (strictly older: a video
 * exactly at the boundary is kept). A video whose `createdAt` cannot be parsed is never deleted.
 * One failed delete does not stop the others.
 */
export async function deleteExpiredVideos(
  backend: VideoBackend,
  now: number,
  retentionHours: number,
): Promise<CleanupResult> {
  const cutoff = now - retentionHours * 3_600_000;
  const videos = await backend.listVideos();
  let deleted = 0;
  let failed = 0;
  for (const { videoId, createdAt } of videos) {
    const created = Date.parse(createdAt);
    if (!Number.isFinite(created) || created >= cutoff) continue;
    try {
      await backend.delete(videoId);
      deleted++;
    } catch {
      failed++;
    }
  }
  return { scanned: videos.length, deleted, failed };
}
