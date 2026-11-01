export interface Env {
  DB: D1Database;
  DATABUDDY_WEBSITE_ID: string;
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  WORKOS_COOKIE_PASSWORD: string;
  WORKOS_REDIRECT_URI: string;
  /**
   * A fine-grained GitHub token with no permissions (public read only), as a Worker secret. Without it
   * GitHub allows 60 requests an hour per IP, which Workers share, so Skills barely work.
   */
  GITHUB_TOKEN?: string;
}
