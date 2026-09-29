import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareStreamBackend } from "../../src/video/cloudflare-stream";
import { createHarness } from "./mcp-harness";

const options = { frameHeight: 720, uploadUrlTtlSeconds: 900, maxVideoDurationSeconds: 300 };

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
  upload?: (url: string, params?: StreamUrlUploadParams) => Promise<unknown>,
) {
  const calls: string[] = [];
  const stream = {
    createDirectUpload: createDirectUpload ?? vi.fn(),
    upload: upload ?? vi.fn(),
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

function namedError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("CloudflareStreamBackend.importFromUrl", () => {
  it("imports with requireSignedURLs and seekio metadata, returning id and status", async () => {
    const upload = vi.fn(async (_url: string, _params?: StreamUrlUploadParams) =>
      video({ id: "imp", status: { state: "downloading" } as StreamVideo["status"] }),
    );
    const { stream } = fakeStream({}, undefined, upload);
    const result = await new CloudflareStreamBackend(stream, options).importFromUrl({
      url: "https://example.com/foo.mp4",
      filename: "foo.mp4",
    });
    expect(result).toEqual({ videoId: "imp", status: "downloading" });
    expect(upload).toHaveBeenCalledTimes(1);
    const [url, params] = upload.mock.calls[0] as [string, StreamUrlUploadParams];
    expect(url).toBe("https://example.com/foo.mp4");
    expect(params.requireSignedURLs).toBe(true);
    expect(params.meta).toEqual({ application: "seekio", filename: "foo.mp4" });
  });

  it("omits filename from meta when not given", async () => {
    const upload = vi.fn(async (_url: string, _params?: StreamUrlUploadParams) => video());
    const { stream } = fakeStream({}, undefined, upload);
    await new CloudflareStreamBackend(stream, options).importFromUrl({
      url: "https://example.com/foo.mp4",
    });
    const params = upload.mock.calls[0]?.[1] as StreamUrlUploadParams;
    expect(params.meta).toEqual({ application: "seekio" });
  });

  it.each([
    ["BadRequestError", "INVALID_URL", /publicly reachable|direct/i],
    ["AlreadyUploadedError", "URL_ALREADY_IMPORTED", /already/i],
    ["MaxFileSizeError", "UPLOAD_CREATE_FAILED", /size/i],
    ["QuotaReachedError", "UPLOAD_CREATE_FAILED", /quota/i],
    ["RateLimitedError", "UPLOAD_CREATE_FAILED", /rate/i],
    ["SomethingElseError", "UPLOAD_CREATE_FAILED", /SomethingElseError/],
  ])("maps %s to %s", async (name, code, pattern) => {
    const { stream } = fakeStream({}, undefined, async () => {
      throw namedError(name, "boom");
    });
    const promise = new CloudflareStreamBackend(stream, options).importFromUrl({
      url: "https://example.com/foo.mp4",
    });
    await expect(promise).rejects.toMatchObject({ code });
    await expect(promise).rejects.toThrow(pattern);
  });
});

describe("errors that carry the kind only in the message (remote binding)", () => {
  const messageError = (message: string) => new Error(message); // name stays "Error"

  it("maps a message-prefixed NotFoundError to VIDEO_NOT_FOUND and makes delete idempotent", async () => {
    const notFoundError = () =>
      messageError("NotFoundError: Not Found: The requested resource or operation was not found.");
    const { stream } = fakeStream({
      details: async () => {
        throw notFoundError();
      },
      delete: async () => {
        throw notFoundError();
      },
    });
    const backend = new CloudflareStreamBackend(stream, options);
    await expect(backend.getInfo("abc")).rejects.toMatchObject({ code: "VIDEO_NOT_FOUND" });
    await expect(backend.delete("abc")).resolves.toBeUndefined();
  });

  it.each([
    ["BadRequestError", "INVALID_URL", /publicly reachable/i],
    ["AlreadyUploadedError", "URL_ALREADY_IMPORTED", /already/i],
    ["MaxFileSizeError", "UPLOAD_CREATE_FAILED", /size/i],
    ["QuotaReachedError", "UPLOAD_CREATE_FAILED", /quota/i],
    ["RateLimitedError", "UPLOAD_CREATE_FAILED", /rate/i],
    ["WeirdError", "UPLOAD_CREATE_FAILED", /WeirdError/],
  ])("maps message-prefixed %s to %s", async (kind, code, pattern) => {
    const { stream } = fakeStream({}, undefined, async () => {
      throw messageError(`${kind}: something https://example.com/v.mp4?sig=secret`);
    });
    const promise = new CloudflareStreamBackend(stream, options).importFromUrl({
      url: "https://example.com/v.mp4",
    });
    await expect(promise).rejects.toMatchObject({ code });
    await expect(promise).rejects.toThrow(pattern);
    if (code === "UPLOAD_CREATE_FAILED") {
      await expect(promise).rejects.not.toThrow(/sig=secret/);
    }
  });

  it("falls back to unknown error when no kind is found", async () => {
    const { stream } = fakeStream({}, undefined, async () => {
      throw messageError("something odd");
    });
    await expect(
      new CloudflareStreamBackend(stream, options).importFromUrl({ url: "https://e.com/v.mp4" }),
    ).rejects.toThrow(/unknown error/);
  });
});

describe("import errors do not leak the source URL", () => {
  it.each(["MaxFileSizeError", "QuotaReachedError", "RateLimitedError", "SomethingElseError"])(
    "%s omits the Stream message from tool results and logs",
    async (name) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { stream } = fakeStream({}, undefined, async () => {
        throw namedError(name, "failed https://example.com/v.mp4?sig=secret");
      });
      const harness = createHarness(new CloudflareStreamBackend(stream, options));
      const result = await harness.callTool("video_import_url", {
        url: "https://example.com/v.mp4?sig=secret",
      });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/^\[UPLOAD_CREATE_FAILED\]/);
      expect(text).not.toContain("sig=secret");
      const logged = [...errorSpy.mock.calls, ...logSpy.mock.calls].map((c) => String(c[0]));
      expect(logged.some((l) => l.includes("backend.error"))).toBe(true);
      expect(logged.join("\n")).not.toContain("sig=secret");
    },
  );
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

  it("converts Stream's string pctComplete to a number and ignores invalid values", async () => {
    const withPct = (pctComplete?: string) =>
      fakeStream({
        details: async () =>
          video({
            readyToStream: false,
            status: { state: "inprogress", errorReasonCode: "", errorReasonText: "", pctComplete },
          } as unknown as Partial<StreamVideo>),
      }).stream;
    const info = await new CloudflareStreamBackend(withPct("42.5"), options).getInfo("abc");
    expect(info.pctComplete).toBe(42.5);
    for (const bad of [undefined, "", "abc", "150", "-3"]) {
      const other = await new CloudflareStreamBackend(withPct(bad), options).getInfo("abc");
      expect("pctComplete" in other).toBe(false);
    }
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
      "https://customer-abc123.cloudflarestream.com/TOKEN/thumbnails/thumbnail.jpg?time=3.347s&height=720&fit=scale",
    );
  });

  it("fullResolution requests the source height (uncapped), or frameHeight when unknown", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL) => {
      urls.push(String(input));
      return new Response(new Uint8Array([0xff]), { status: 200 });
    });
    const run = async (input: StreamVideo["input"] | undefined, full: boolean) => {
      const { stream } = fakeStream({
        details: async () => video({ input } as Partial<StreamVideo>),
        generateToken: async () => "TOKEN",
      });
      await new CloudflareStreamBackend(stream, options).getFrame(
        "abc",
        1,
        full ? { fullResolution: true } : undefined,
      );
      return new URL(urls.at(-1) as string).searchParams.get("height");
    };
    expect(await run({ width: 3840, height: 2160 }, true)).toBe("2160");
    expect(await run({ width: 3840, height: 2160 }, false)).toBe("720");
    expect(await run({ width: -1, height: -1 }, true)).toBe("720");
  });

  it("fullResolution keeps the end-of-video retry", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL) => {
      urls.push(String(input));
      return urls.length === 1
        ? new Response("no", { status: 404 })
        : new Response(new Uint8Array([0xff]), { status: 200 });
    });
    const { stream } = fakeStream({
      details: async () => video({ duration: 10, input: { width: 1920, height: 1080 } }),
      generateToken: async () => "TOKEN",
    } as Handle);
    const frame = await new CloudflareStreamBackend(stream, options).getFrame("abc", 9.9, {
      fullResolution: true,
    });
    expect(frame.timestamp).toBeLessThan(9.9);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1] as string).searchParams.get("height")).toBe("1080");
  });

  it("never upscales: uses min(source height, frameHeight)", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL) => {
      urls.push(String(input));
      return new Response(new Uint8Array([0xff]), { status: 200 });
    });
    const heightOf = async (height: number | undefined) => {
      const input = height === undefined ? { width: -1, height: -1 } : { width: 100, height };
      const { stream } = fakeStream({
        details: async () => video({ input } as Partial<StreamVideo>),
        generateToken: async () => "T",
      });
      await new CloudflareStreamBackend(stream, options).getFrame("abc", 1);
      return new URL(urls.at(-1) as string).searchParams.get("height");
    };
    expect(await heightOf(360)).toBe("360");
    expect(await heightOf(480)).toBe("480");
    expect(await heightOf(720)).toBe("720");
    expect(await heightOf(2556)).toBe("720");
    expect(await heightOf(undefined)).toBe("720");
  });

  it("does not put the raw network error message (which may contain the URL) in frame errors", async () => {
    const { stream } = fakeStream({
      details: async () => video(),
      generateToken: async () => "SECRET",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (input: URL) => {
      const error = new TypeError(`fetch failed for ${String(input)}`);
      throw error;
    });
    const harness = createHarness(new CloudflareStreamBackend(stream, options));
    const result = await harness.callTool("video_frame", { video_id: "abc", at: 1 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^\[FRAME_FETCH_FAILED\]/);
    expect(text).toContain("TypeError");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("cloudflarestream.com");
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("SECRET");
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

  describe("frames near the end of the video", () => {
    function endStream(duration = 52.21) {
      return fakeStream({
        details: async () => video({ duration }),
        generateToken: async () => "SECRET",
      });
    }
    const timeOf = (input: URL) => new URL(input).searchParams.get("time");

    it("retries slightly earlier on HTTP 4xx and reports the time actually fetched", async () => {
      const seen: (string | null)[] = [];
      vi.stubGlobal("fetch", async (input: URL) => {
        seen.push(timeOf(input));
        return seen.length < 3
          ? new Response("bad", { status: 400 })
          : new Response(new Uint8Array([0xff]), { status: 200 });
      });
      const frame = await new CloudflareStreamBackend(endStream().stream, options).getFrame(
        "abc",
        52.209,
      );
      expect(seen).toEqual(["52.209s", "52.109s", "51.709s"]);
      expect(frame.timestamp).toBe(51.709);
    });

    it("gives up with FRAME_FETCH_FAILED after all fallbacks fail", async () => {
      const fetchMock = vi.fn(async (_input: URL) => new Response("bad", { status: 400 }));
      vi.stubGlobal("fetch", fetchMock);
      const error = await new CloudflareStreamBackend(endStream().stream, options)
        .getFrame("abc", 52.209)
        .catch((e) => e);
      expect(error.code).toBe("FRAME_FETCH_FAILED");
      expect(error.message).toContain("400");
      expect(error.message).not.toContain("SECRET");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("does not retry away from the end, on 5xx, or below 0", async () => {
      const fetchMock = vi.fn(async (_input: URL) => new Response("bad", { status: 400 }));
      vi.stubGlobal("fetch", fetchMock);
      const backend = new CloudflareStreamBackend(endStream().stream, options);
      await backend.getFrame("abc", 30).catch(() => {});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fetchMock.mockClear();
      fetchMock.mockImplementation(async () => new Response("bad", { status: 503 }));
      await backend.getFrame("abc", 52.209).catch(() => {});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // very short video: candidates are clamped at 0 and never negative
      fetchMock.mockClear();
      fetchMock.mockImplementation(async () => new Response("bad", { status: 400 }));
      const short = new CloudflareStreamBackend(endStream(0.5).stream, options);
      await short.getFrame("abc", 0.3).catch(() => {});
      const times = fetchMock.mock.calls.map((c) => Number.parseFloat(timeOf(c[0]) as string));
      expect(times.every((t) => t >= 0)).toBe(true);
      expect(new Set(times).size).toBe(times.length);
    });
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

describe("RPC stub disposal", () => {
  /** Adds a Symbol.dispose spy to an object (handle or RPC result). */
  function disposable<T extends object>(value: T) {
    const dispose = vi.fn();
    Object.defineProperty(value, Symbol.dispose, { value: dispose });
    return { value, dispose };
  }

  function disposableHandle(methods: Handle) {
    const h = disposable({ ...methods });
    return { handle: h.value as Handle, dispose: h.dispose };
  }

  function streamWith(handle: Handle) {
    return {
      video: () => handle as unknown as StreamVideoHandle,
      createDirectUpload: vi.fn(),
      upload: vi.fn(),
    } as unknown as StreamBinding;
  }

  it("disposes the handle and details result on getInfo (success and NotFound)", async () => {
    const result = disposable(video());
    const ok = disposableHandle({ details: async () => result.value });
    await new CloudflareStreamBackend(streamWith(ok.handle), options).getInfo("abc");
    expect(ok.dispose).toHaveBeenCalledTimes(1);
    expect(result.dispose).toHaveBeenCalledTimes(1);

    const missing = disposableHandle({ details: async () => Promise.reject(notFound()) });
    await expect(
      new CloudflareStreamBackend(streamWith(missing.handle), options).getInfo("x"),
    ).rejects.toMatchObject({ code: "VIDEO_NOT_FOUND" });
    expect(missing.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes handles on the thumbnail path, including when generateToken throws", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([0xff]), { status: 200 }));
    const result = disposable(video());
    const ok = disposableHandle({
      details: async () => result.value,
      generateToken: async () => "TOKEN",
    });
    const frame = await new CloudflareStreamBackend(streamWith(ok.handle), options).getFrame(
      "abc",
      1,
    );
    expect(frame.mimeType).toBe("image/jpeg");
    expect(ok.dispose).toHaveBeenCalledTimes(2); // details + generateToken
    expect(result.dispose).toHaveBeenCalledTimes(1);

    const broken = disposableHandle({
      details: async () => video(),
      generateToken: async () => Promise.reject(new Error("boom")),
    });
    await expect(
      new CloudflareStreamBackend(streamWith(broken.handle), options).getFrame("abc", 1),
    ).rejects.toMatchObject({ code: "BACKEND_ERROR" });
    expect(broken.dispose).toHaveBeenCalledTimes(2);
  });

  it("disposes the handle on delete (success, NotFound, other error)", async () => {
    for (const outcome of [undefined, notFound(), new Error("503")]) {
      const h = disposableHandle({
        delete: async () => (outcome ? Promise.reject(outcome) : undefined),
      });
      await new CloudflareStreamBackend(streamWith(h.handle), options).delete("x").catch(() => {});
      expect(h.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it("disposes the upload() result on importFromUrl", async () => {
    const result = disposable(video({ id: "imp" }));
    const stream = { upload: async () => result.value } as unknown as StreamBinding;
    const imported = await new CloudflareStreamBackend(stream, options).importFromUrl({
      url: "https://example.com/foo.mp4",
    });
    expect(imported).toEqual({ videoId: "imp", status: "ready" });
    expect(result.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the upload() result even when the status is unknown", async () => {
    const result = disposable(
      video({ status: { state: "weird" } as unknown as StreamVideo["status"] }),
    );
    const stream = { upload: async () => result.value } as unknown as StreamBinding;
    await expect(
      new CloudflareStreamBackend(stream, options).importFromUrl({ url: "https://e.com/v.mp4" }),
    ).rejects.toMatchObject({ code: "BACKEND_ERROR" });
    expect(result.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the createDirectUpload() result", async () => {
    const result = disposable({ id: "vid", uploadURL: "https://u.example/vid" });
    const stream = { createDirectUpload: async () => result.value } as unknown as StreamBinding;
    const upload = await new CloudflareStreamBackend(stream, options).createUpload({});
    expect(upload.videoId).toBe("vid");
    expect(upload.uploadUrl).toBe("https://u.example/vid");
    expect(result.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("CloudflareStreamBackend scheduledDeletion safety net", () => {
  const NOW = Date.parse("2026-06-10T12:00:00.000Z");
  const expected = new Date(NOW + 31 * 24 * 3_600_000).toISOString();
  const fixedClock = { ...options, now: () => NOW };

  it("passes scheduledDeletion 31 days out to createDirectUpload", async () => {
    const createDirectUpload = vi.fn(async (_params: StreamDirectUploadCreateParams) => ({
      id: "vid",
      uploadURL: "https://upload.cloudflarestream.com/vid",
      watermark: null,
      scheduledDeletion: null,
    }));
    const { stream } = fakeStream({}, createDirectUpload);
    await new CloudflareStreamBackend(stream, fixedClock).createUpload({});
    const params = createDirectUpload.mock.calls[0]?.[0] as StreamDirectUploadCreateParams;
    expect(params.scheduledDeletion).toBe(expected);
  });

  it("passes scheduledDeletion 31 days out to stream.upload", async () => {
    const upload = vi.fn(async (_url: string, _params?: StreamUrlUploadParams) => video());
    const { stream } = fakeStream({}, undefined, upload);
    await new CloudflareStreamBackend(stream, fixedClock).importFromUrl({
      url: "https://example.com/foo.mp4",
    });
    const params = upload.mock.calls[0]?.[1] as StreamUrlUploadParams;
    expect(params.scheduledDeletion).toBe(expected);
  });
});

describe("CloudflareStreamBackend.listVideos", () => {
  function listed(id: string, created: string, meta: Record<string, string> | undefined) {
    return video({ id, created, ...(meta && { meta }) } as Partial<StreamVideo>);
  }

  /** A `videos.list` that honours limit/before/beforeComp, newest first, like Stream. */
  function listingStream(all: StreamVideo[]) {
    const params: StreamVideosListParams[] = [];
    const sorted = [...all].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
    const list = vi.fn(async (p: StreamVideosListParams = {}) => {
      params.push(p);
      const before = p.before === undefined ? Number.POSITIVE_INFINITY : Date.parse(p.before);
      const inclusive = p.beforeComp === "lte";
      return sorted
        .filter((v) => {
          const t = Date.parse(v.created);
          return inclusive ? t <= before : t < before;
        })
        .slice(0, p.limit ?? 1000);
    });
    const stream = { videos: { list } } as unknown as StreamBinding;
    return { stream, params, list };
  }

  it("returns only videos whose meta.application is seekio", async () => {
    const { stream } = listingStream([
      listed("mine", "2026-01-03T00:00:00Z", { application: "seekio", filename: "a.mp4" }),
      listed("other-app", "2026-01-02T00:00:00Z", { application: "someone-else" }),
      listed("no-meta", "2026-01-01T00:00:00Z", undefined),
      listed("empty-meta", "2025-12-31T00:00:00Z", {}),
      listed("case", "2025-12-30T00:00:00Z", { application: "Seekio" }),
    ]);
    const result = await new CloudflareStreamBackend(stream, options).listVideos();
    expect(result).toEqual([{ videoId: "mine", createdAt: "2026-01-03T00:00:00Z" }]);
  });

  it("treats a missing meta property as not seekio", async () => {
    const noMeta = video({ id: "x" });
    (noMeta as unknown as { meta?: unknown }).meta = undefined;
    const { stream } = listingStream([noMeta]);
    expect(await new CloudflareStreamBackend(stream, options).listVideos()).toEqual([]);
  });

  it("pages through every video until a short page is returned", async () => {
    const all: StreamVideo[] = [];
    for (let i = 0; i < 250; i++) {
      const created = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      all.push(
        listed(
          `v${i}`,
          created,
          i % 5 === 0 ? { application: "other" } : { application: "seekio" },
        ),
      );
    }
    const { stream, list } = listingStream(all);
    const result = await new CloudflareStreamBackend(stream, options).listVideos();
    expect(list.mock.calls.length).toBeGreaterThan(1);
    expect(result).toHaveLength(200);
    expect(new Set(result.map((v) => v.videoId)).size).toBe(200);
    expect(result.some((v) => Number(v.videoId.slice(1)) % 5 === 0)).toBe(false);
  });

  it("does not skip videos that share the boundary timestamp between pages", async () => {
    const tie = "2026-01-01T00:00:00Z";
    const all = [
      ...Array.from({ length: 60 }, (_, i) =>
        listed(`n${i}`, "2026-01-02T00:00:00Z", { application: "seekio" }),
      ),
      // Page 1 (limit 100) ends 40 videos into this tie group of 60.
      ...Array.from({ length: 60 }, (_, i) => listed(`s${i}`, tie, { application: "seekio" })),
      listed("older", "2025-12-31T00:00:00Z", { application: "seekio" }),
    ];
    const { stream } = listingStream(all);
    const result = await new CloudflareStreamBackend(stream, options).listVideos();
    expect(result).toHaveLength(121);
    expect(new Set(result.map((v) => v.videoId)).size).toBe(121);
  });

  it("stops instead of looping forever when a page makes no progress", async () => {
    const stuck = Array.from({ length: 100 }, (_, i) =>
      listed(`t${i}`, "2026-01-01T00:00:00Z", { application: "seekio" }),
    );
    const list = vi.fn(async () => stuck);
    const stream = { videos: { list } } as unknown as StreamBinding;
    const result = await new CloudflareStreamBackend(stream, options).listVideos();
    expect(result).toHaveLength(100);
    expect(list.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("maps list failures to BACKEND_ERROR", async () => {
    const stream = {
      videos: {
        list: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as StreamBinding;
    await expect(new CloudflareStreamBackend(stream, options).listVideos()).rejects.toMatchObject({
      code: "BACKEND_ERROR",
    });
  });

  it("disposes the list result and every video in it", async () => {
    const dispose = vi.fn();
    const key = (Symbol as { dispose?: symbol }).dispose ?? Symbol.for("Symbol.dispose");
    const item = Object.assign(listed("d", "2026-01-01T00:00:00Z", { application: "seekio" }), {
      [key]: dispose,
    });
    const page = Object.assign([item], { [key]: dispose });
    const stream = { videos: { list: async () => page } } as unknown as StreamBinding;
    if (!(Symbol as { dispose?: symbol }).dispose) {
      (Symbol as { dispose?: symbol }).dispose = key;
    }
    await new CloudflareStreamBackend(stream, options).listVideos();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

describe("thumbnail 404 retry", () => {
  const timeOf = (input: URL) => new URL(input).searchParams.get("time");

  function setup(duration = 150.8) {
    const sleeps: number[] = [];
    const { stream } = fakeStream({
      details: async () => video({ duration }),
      generateToken: async () => "SECRET",
    });
    const backend = new CloudflareStreamBackend(stream, {
      ...options,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    return { backend, sleeps };
  }

  /** Answers with the given statuses in order; the last one repeats. */
  function stubStatuses(statuses: number[]) {
    let i = 0;
    const fetchMock = vi.fn(async (_input: URL) => {
      const status = statuses[Math.min(i++, statuses.length - 1)] as number;
      return status === 200
        ? new Response(new Uint8Array([0xff]), { status })
        : new Response("no", { status });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("retries the same time on 404 and succeeds", async () => {
    const fetchMock = stubStatuses([404, 200]);
    const { backend, sleeps } = setup();
    const frame = await backend.getFrame("abc", 148.5, { maxNotFoundRetries: 3 });
    expect(frame.timestamp).toBe(148.5);
    expect(fetchMock.mock.calls.map((c) => timeOf(c[0]))).toEqual(["148.5s", "148.5s"]);
    expect(sleeps).toEqual([1000]);
  });

  it("gives up after the given number of retries with backoff 1s, 2s, 4s", async () => {
    const fetchMock = stubStatuses([404]);
    const { backend, sleeps } = setup();
    const error = await backend.getFrame("abc", 30, { maxNotFoundRetries: 3 }).catch((e) => e);
    expect(error.code).toBe("FRAME_FETCH_FAILED");
    expect(error.message).toContain("404");
    expect(error.message).not.toContain("SECRET");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("retries at most once with 1s for multi-frame calls", async () => {
    const fetchMock = stubStatuses([404]);
    const { backend, sleeps } = setup();
    await backend.getFrame("abc", 30, { maxNotFoundRetries: 1 }).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
  });

  it("does not retry 404 by default", async () => {
    const fetchMock = stubStatuses([404]);
    const { backend, sleeps } = setup();
    await backend.getFrame("abc", 30).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry non-404 statuses away from the end", async () => {
    for (const status of [400, 403, 503]) {
      const fetchMock = stubStatuses([status]);
      const { backend, sleeps } = setup();
      await backend.getFrame("abc", 30, { maxNotFoundRetries: 3 }).catch(() => {});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("combines with the end-of-video retry: 404 retries first, then earlier times once each", async () => {
    const fetchMock = stubStatuses([404]);
    const { backend, sleeps } = setup(52.21);
    const error = await backend.getFrame("abc", 52.209, { maxNotFoundRetries: 1 }).catch((e) => e);
    expect(error.code).toBe("FRAME_FETCH_FAILED");
    expect(fetchMock.mock.calls.map((c) => timeOf(c[0]))).toEqual([
      "52.209s",
      "52.209s",
      "52.109s",
      "51.709s",
      "51.209s",
    ]);
    expect(sleeps).toEqual([1000]);
  });

  it("does not step back to earlier times when retryEarlier is false, and still advises", async () => {
    const fetchMock = stubStatuses([400]);
    const { backend } = setup(52.21);
    const error = await backend
      .getFrame("abc", 52.209, { maxNotFoundRetries: 1, retryEarlier: false })
      .catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.message).toMatch(/earlier time/i);
    fetchMock.mockClear();
    stubStatuses([404]);
    const notFoundFetch = stubStatuses([404]);
    await setup(52.21)
      .backend.getFrame("abc", 52.209, { maxNotFoundRetries: 1, retryEarlier: false })
      .catch(() => {});
    expect(notFoundFetch).toHaveBeenCalledTimes(2);
  });

  it("uses an earlier time after 404 retries are exhausted near the end", async () => {
    stubStatuses([404, 404, 200]);
    const { backend } = setup(52.21);
    const frame = await backend.getFrame("abc", 52.209, { maxNotFoundRetries: 1 });
    expect(frame.timestamp).toBe(52.109);
  });

  it("retries 400 near the end only through earlier times (no sleeping)", async () => {
    const fetchMock = stubStatuses([400]);
    const { backend, sleeps } = setup(52.21);
    await backend.getFrame("abc", 52.209, { maxNotFoundRetries: 3 }).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([]);
  });

  it("uses different next-step advice for 404 and for 400 near the end", async () => {
    stubStatuses([404]);
    const notFoundError = await setup()
      .backend.getFrame("abc", 30)
      .catch((e) => e);
    expect(notFoundError.message).toContain("404");
    expect(notFoundError.message).toMatch(/30.{0,20}60 seconds/);
    expect(notFoundError.message).toContain("0.1");
    expect(notFoundError.message).not.toMatch(/video track/i);

    stubStatuses([400]);
    const tailError = await setup(52.21)
      .backend.getFrame("abc", 52.209)
      .catch((e) => e);
    expect(tailError.message).toContain("400");
    expect(tailError.message).toMatch(/video track/i);
    expect(tailError.message).toMatch(/earlier/i);
    expect(tailError.message).not.toMatch(/60 seconds/);
  });

  it("keeps a plain message for other statuses", async () => {
    stubStatuses([503]);
    const error = await setup()
      .backend.getFrame("abc", 30)
      .catch((e) => e);
    expect(error.message).toContain("503");
    expect(error.message).not.toMatch(/video track|60 seconds/);
  });
});

describe("CloudflareStreamBackend captions", () => {
  type Captions = {
    list?: (language?: string) => Promise<unknown>;
    generate?: (language: string) => Promise<unknown>;
  };

  function captionStream(captions: Captions, extra: Handle = {}) {
    return fakeStream({
      details: async () => video(),
      generateToken: async () => "SECRET",
      captions,
      ...extra,
    } as unknown as Handle);
  }

  const backendFor = (captions: Captions, extra: Handle = {}) =>
    new CloudflareStreamBackend(captionStream(captions, extra).stream, options);

  it("lists captions as language + status, treating a missing status as ready", async () => {
    const backend = backendFor({
      list: async () => [
        { language: "ja", label: "日本語", generated: true, status: "inprogress" },
        { language: "en", label: "English", generated: true, status: "ready" },
        { language: "fr", label: "Français", generated: false },
        { language: "de", label: "Deutsch", generated: true, status: "error" },
      ],
    });
    expect(await backend.getCaptions("abc")).toEqual([
      { language: "ja", status: "inprogress" },
      { language: "en", status: "ready" },
      { language: "fr", status: "ready" },
      { language: "de", status: "error" },
    ]);
  });

  it("maps a missing video to VIDEO_NOT_FOUND when listing", async () => {
    const backend = backendFor({
      list: async () => {
        throw namedError("NotFoundError");
      },
    });
    await expect(backend.getCaptions("abc")).rejects.toMatchObject({ code: "VIDEO_NOT_FOUND" });
  });

  it("generates a caption for the given language", async () => {
    const generate = vi.fn(async (_language: string) => ({ language: "ja" }));
    await backendFor({ generate }).generateCaption("abc", "ja");
    expect(generate).toHaveBeenCalledWith("ja");
  });

  it("treats an existing caption (BadRequestError) as success", async () => {
    const backend = backendFor({
      generate: async () => {
        throw new Error(
          "BadRequestError: There is an existing caption for this language, delete it first",
        );
      },
    });
    await expect(backend.generateCaption("abc", "ja")).resolves.toBeUndefined();
  });

  it.each([
    ["StreamBindingError: Missing Audio: the video has no audio", "NO_AUDIO_TRACK", /no audio/i],
    ["StreamBindingError: Language not supported: xx", "UNSUPPORTED_LANGUAGE", /ja, ko/],
    ["BadRequestError: Language not supported: xx", "UNSUPPORTED_LANGUAGE", /en rather than en-US/],
    ["BadRequestError: invalid language tag", "TRANSCRIPT_FAILED", /video_transcript again/],
    ["NotFoundError: Not Found", "VIDEO_NOT_FOUND", /abc/],
    ["InternalError: boom", "BACKEND_ERROR", /boom/],
  ])("maps the generate error %s to %s", async (message, code, pattern) => {
    const backend = backendFor({
      generate: async () => {
        throw new Error(message);
      },
    });
    const promise = backend.generateCaption("abc", "ja");
    await expect(promise).rejects.toMatchObject({ code });
    await expect(promise).rejects.toThrow(pattern);
  });

  it("fetches the WebVTT body from <origin>/<token>/captions/<lang>", async () => {
    const fetchMock = vi.fn(
      async (_input: URL) =>
        new Response("WEBVTT\n\n00:00.000 --> 00:01.000\nhi", {
          status: 200,
          headers: { "content-type": "text/vtt" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const text = await backendFor({}).getCaptionText("abc", "ja");
    expect(text).toContain("WEBVTT");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://customer-abc123.cloudflarestream.com/SECRET/captions/ja",
    );
  });

  it("reports a failed text fetch as TRANSCRIPT_FAILED without leaking the token", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 404 }));
    const error = await backendFor({})
      .getCaptionText("abc", "ja")
      .catch((e) => e);
    expect(error.code).toBe("TRANSCRIPT_FAILED");
    expect(error.message).toContain("404");
    expect(error.message).not.toContain("SECRET");
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const network = await backendFor({})
      .getCaptionText("abc", "ja")
      .catch((e) => e);
    expect(network.code).toBe("TRANSCRIPT_FAILED");
    expect(network.message).not.toContain("SECRET");
  });

  it("keeps the token and URL out of caption text errors and logs, whatever the network error says", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const backend = backendFor({});
    vi.stubGlobal("fetch", async (input: URL | string) => {
      throw new TypeError(`failed to fetch ${String(input)} (token SECRET)`);
    });
    const error = await backend.getCaptionText("abc", "ja").catch((e) => e);
    expect(error.code).toBe("TRANSCRIPT_FAILED");
    expect(error.message).toContain("TypeError");
    for (const leak of ["SECRET", "cloudflarestream.com", "captions/ja", "failed to fetch"]) {
      expect(error.message).not.toContain(leak);
    }
    const harness = createHarness(backend);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await harness.callTool("video_transcript", { video_id: "abc", languages: ["ja"] });
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("SECRET");
  });

  it("disposes the captions stub and the list result", async () => {
    const dispose = vi.fn();
    const captionsStub = {
      list: async () => {
        const list = [{ language: "ja", label: "x", status: "ready" }];
        Object.defineProperty(list, Symbol.dispose, { value: dispose });
        return list;
      },
    };
    const captionsDispose = vi.fn();
    Object.defineProperty(captionsStub, Symbol.dispose, { value: captionsDispose });
    await backendFor(captionsStub).getCaptions("abc");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(captionsDispose).toHaveBeenCalledTimes(1);
  });
});
