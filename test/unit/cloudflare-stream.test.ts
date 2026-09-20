import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareStreamBackend } from "../../src/video/cloudflare-stream";

const options = { frameHeight: 1080, uploadUrlTtlSeconds: 900, maxVideoDurationSeconds: 300 };

function notFound(): Error {
  const error = new Error("video not found");
  error.name = "NotFoundError";
  return error;
}

function video(overrides: Partial<StreamVideo> = {}): StreamVideo {
  return {
    id: "abc",
    readyToStream: true,
    status: { state: "ready", errorReasonCode: "", errorReasonText: "" },
    duration: 14.82,
    input: { width: 1179, height: 2556 },
    created: "2026-01-01T00:00:00Z",
    thumbnail: "https://customer-abc123.cloudflarestream.com/abc/thumbnails/thumbnail.jpg",
    meta: {},
    ...overrides,
  } as unknown as StreamVideo;
}

type Handle = Partial<Record<"details" | "delete" | "generateToken", () => Promise<unknown>>>;

function fakeStream(
  handle: Handle,
  createDirectUpload?: (params: StreamDirectUploadCreateParams) => Promise<unknown>,
) {
  const calls: string[] = [];
  const stream = {
    createDirectUpload: createDirectUpload ?? vi.fn(),
    video: (id: string) => {
      calls.push(id);
      return handle as unknown as StreamVideoHandle;
    },
  } as unknown as StreamBinding;
  return { stream, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudflareStreamBackend", () => {
  it("creates signed direct uploads with seekio metadata and TTL expiry", async () => {
    const createDirectUpload = vi.fn(async (_params: StreamDirectUploadCreateParams) => ({
      id: "vid",
      uploadURL: "https://upload.cloudflarestream.com/vid",
      watermark: null,
      scheduledDeletion: null,
    }));
    const { stream } = fakeStream({}, createDirectUpload);
    const backend = new CloudflareStreamBackend(stream, options);
    const before = Date.now();
    const upload = await backend.createUpload({ filename: "drawer.mp4" });
    expect(upload.videoId).toBe("vid");
    expect(upload.uploadUrl).toBe("https://upload.cloudflarestream.com/vid");
    const params = createDirectUpload.mock
      .calls[0]?.[0] as unknown as StreamDirectUploadCreateParams;
    expect(params.requireSignedURLs).toBe(true);
    expect(params.maxDurationSeconds).toBe(300);
    expect(params.meta).toEqual({ application: "seekio", filename: "drawer.mp4" });
    const expiry = Date.parse(params.expiry as string);
    expect(expiry).toBeGreaterThanOrEqual(before + 900_000 - 1000);
    expect(upload.expiresAt).toBe(params.expiry);
  });

  it("maps upload failures to UPLOAD_CREATE_FAILED", async () => {
    const { stream } = fakeStream({}, async () => {
      throw new Error("quota");
    });
    await expect(
      new CloudflareStreamBackend(stream, options).createUpload({}),
    ).rejects.toMatchObject({
      code: "UPLOAD_CREATE_FAILED",
    });
  });

  it("maps ready video details to VideoInfo", async () => {
    const { stream } = fakeStream({ details: async () => video() });
    const info = await new CloudflareStreamBackend(stream, options).getInfo("abc");
    expect(info).toEqual({
      id: "abc",
      status: "ready",
      duration: 14.82,
      width: 1179,
      height: 2556,
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("omits duration while the video is still processing", async () => {
    const { stream } = fakeStream({
      details: async () =>
        video({
          readyToStream: false,
          status: { state: "inprogress", errorReasonCode: "", errorReasonText: "" },
          duration: -1,
          input: { width: -1, height: -1 },
        } as Partial<StreamVideo>),
    });
    const info = await new CloudflareStreamBackend(stream, options).getInfo("abc");
    expect(info).toEqual({ id: "abc", status: "inprogress", createdAt: "2026-01-01T00:00:00Z" });
  });

  it("maps NotFoundError to VIDEO_NOT_FOUND and other errors to BACKEND_ERROR", async () => {
    const missing = fakeStream({ details: async () => Promise.reject(notFound()) });
    await expect(
      new CloudflareStreamBackend(missing.stream, options).getInfo("x"),
    ).rejects.toMatchObject({
      code: "VIDEO_NOT_FOUND",
    });
    const broken = fakeStream({ details: async () => Promise.reject(new Error("500")) });
    await expect(
      new CloudflareStreamBackend(broken.stream, options).getInfo("x"),
    ).rejects.toMatchObject({
      code: "BACKEND_ERROR",
    });
  });

  it("fetches signed thumbnails and memoizes the token per video", async () => {
    const details = vi.fn(async () => video());
    const generateToken = vi.fn(async () => "TOKEN");
    const { stream } = fakeStream({ details, generateToken });
    const fetchMock = vi.fn(
      async (_input: URL) => new Response(new Uint8Array([0xff, 0xd8]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const backend = new CloudflareStreamBackend(stream, options);
    const frame = await backend.getFrame("abc", 3.347);
    await backend.getFrame("abc", 4);
    expect(frame.mimeType).toBe("image/jpeg");
    expect(new Uint8Array(frame.data)).toEqual(new Uint8Array([0xff, 0xd8]));
    expect(details).toHaveBeenCalledTimes(1);
    expect(generateToken).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe(
      "https://customer-abc123.cloudflarestream.com/TOKEN/thumbnails/thumbnail.jpg?time=3.347s&height=1080&fit=scale",
    );
  });

  it("reports non-200 thumbnail responses as FRAME_FETCH_FAILED without leaking the token", async () => {
    const { stream } = fakeStream({
      details: async () => video(),
      generateToken: async () => "SECRET",
    });
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    const error = await new CloudflareStreamBackend(stream, options)
      .getFrame("abc", 1)
      .catch((e) => e);
    expect(error.code).toBe("FRAME_FETCH_FAILED");
    expect(error.message).toContain("404");
    expect(error.message).not.toContain("SECRET");
  });

  it("treats deleting a missing video as success", async () => {
    const gone = fakeStream({ delete: async () => Promise.reject(notFound()) });
    await expect(
      new CloudflareStreamBackend(gone.stream, options).delete("x"),
    ).resolves.toBeUndefined();
    const broken = fakeStream({ delete: async () => Promise.reject(new Error("503")) });
    await expect(
      new CloudflareStreamBackend(broken.stream, options).delete("x"),
    ).rejects.toMatchObject({
      code: "BACKEND_ERROR",
    });
  });
});
