/**
 * Typed application errors with a consistent JSON shape.
 *
 * The response body uses `{ detail: string }` — the same shape FastAPI produced
 * — so the existing frontend error parsing in `web/src/api/client.ts` keeps
 * working unchanged during the migration.
 */

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (m: string, code?: string) => new AppError(400, m, code);
export const unauthorized = (m = "Invalid or expired token") => new AppError(401, m);
export const forbidden = (m: string) => new AppError(403, m);
export const notFound = (m: string) => new AppError(404, m);
export const conflict = (m: string) => new AppError(409, m);
export const payloadTooLarge = (m: string) => new AppError(413, m);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
