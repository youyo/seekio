export interface Env {
  STREAM: StreamBinding;
  /** Overrides `defaults.maxVideoDurationSeconds` (Worker var, string). */
  MAX_VIDEO_DURATION_SECONDS?: string;
  /** Overrides `defaults.uploadUrlTtlSeconds` (Worker var, string). */
  UPLOAD_URL_TTL_SECONDS?: string;
  /** Secret. When set, `/mcp` requires `Authorization: Bearer <token>`. */
  SEEKIO_AUTH_TOKEN?: string;
  /** Cloudflare Access team domain, e.g. `myteam.cloudflareaccess.com`. Enables JWT validation together with `CF_ACCESS_AUD`. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application audience (AUD) tag. */
  CF_ACCESS_AUD?: string;
}
