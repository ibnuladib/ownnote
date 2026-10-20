export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** pbkdf2-sha256:<iterations>:<salt b64url>:<hash b64url> (see scripts/hash-password.mjs) */
  PASSWORD_HASH?: string;
}

export type AppEnv = { Bindings: Env; ExecutionContext: ExecutionContext };

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500,
    message: string,
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}
