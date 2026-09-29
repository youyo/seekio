export type LogEvent =
  | "upload.created"
  | "upload.imported"
  | "video.info"
  | "overview.requested"
  | "frames.requested"
  | "frame.requested"
  | "video.deleted"
  | "backend.error"
  | "auth.rejected";

/**
 * Structured single-line log. Never pass tokens, upload URLs, Authorization headers,
 * or frame bytes: callers own that discipline and the type gives no escape hatch for binaries.
 */
export function log(
  event: LogEvent,
  fields: Record<string, string | number | boolean | undefined>,
): void {
  const line = JSON.stringify({ event, ...fields });
  if (event === "backend.error") console.error(line);
  else if (event === "auth.rejected") console.warn(line);
  else console.log(line);
}
