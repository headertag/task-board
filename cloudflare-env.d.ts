declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    IMAGES?: R2Bucket;
    WORKOS_AUTHKIT_ISSUER?: string;
    WORKOS_MCP_AUDIENCE?: string;
    WORKOS_API_KEY?: string;
    TASK_BOARD_AUTH_POLICY?: string;
    TASK_BOARD_ORIGIN?: string;
    WORKOS_BROWSER_CLIENT_ID?: string;
    TASK_BOARD_SESSION_SECRET?: string;
    TASK_BOARD_READ_ONLY?: string;
  }
}
