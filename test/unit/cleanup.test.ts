import { describe, expect, it } from "vitest";
import { deleteExpiredVideos } from "../../src/video/cleanup";
import { FakeVideoBackend } from "./fake-backend";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function backendWith(videos: Record<string, string>): FakeVideoBackend {
  const backend = new FakeVideoBackend();
  for (const [id, createdAt] of Object.entries(videos)) backend.addVideo({ id, createdAt });
  return backend;
}

const deletedIds = (backend: FakeVideoBackend) =>
  backend.calls.flatMap((c) => (c.op === "delete" ? [c.videoId] : []));

describe("deleteExpiredVideos", () => {
  it("deletes videos older than the retention and keeps the rest", async () => {
    const backend = backendWith({
      old: at(-24 * HOUR - 1000),
      exact: at(-24 * HOUR),
      fresh: at(-24 * HOUR + 1000),
      recent: at(-HOUR),
    });
    const result = await deleteExpiredVideos(backend, NOW, 24);
    expect(deletedIds(backend)).toEqual(["old"]);
    expect(result).toMatchObject({ deleted: 1, failed: 0 });
  });

  it("uses the given retention hours", async () => {
    const backend = backendWith({ a: at(-2 * HOUR - 1), b: at(-2 * HOUR + 1) });
    await deleteExpiredVideos(backend, NOW, 2);
    expect(deletedIds(backend)).toEqual(["a"]);
  });

  it("never deletes a video whose createdAt cannot be parsed", async () => {
    const backend = backendWith({ garbled: "not-a-date", empty: "", old: at(-100 * HOUR) });
    const result = await deleteExpiredVideos(backend, NOW, 24);
    expect(deletedIds(backend)).toEqual(["old"]);
    expect(result).toMatchObject({ deleted: 1, failed: 0 });
  });

  it("keeps going after a failed delete and counts it", async () => {
    const backend = backendWith({
      a: at(-30 * HOUR),
      b: at(-30 * HOUR),
      c: at(-30 * HOUR),
    });
    backend.failDeleteIds.add("b");
    const result = await deleteExpiredVideos(backend, NOW, 24);
    expect(deletedIds(backend)).toEqual(["a", "b", "c"]);
    expect(result).toMatchObject({ deleted: 2, failed: 1 });
  });

  it("does nothing when there are no videos", async () => {
    const backend = new FakeVideoBackend();
    expect(await deleteExpiredVideos(backend, NOW, 24)).toMatchObject({ deleted: 0, failed: 0 });
  });
});
