/**
 * Typed application errors with a consistent JSON shape.
 *
 * The response body uses `{ detail: string }` — the same shape FastAPI produced
 * — so the existing frontend error parsing in `web/src/api/client.ts` keeps
 * working unchanged. `code`/`requestId`/`timestamp`/`errors` are added
 * alongside `detail` by the global error handler (see index.ts), never
 * replacing it — additive fields are safe for any JSON consumer.
 *
 * Every subclass below maps to exactly one HTTP status + a stable default
 * `code`. The old factory functions (`badRequest`, `notFound`, ...) are kept
 * with their original signatures so none of the ~30 existing call sites need
 * to change — they now just construct the matching subclass under the hood.
 */

import { ErrorCode, HttpStatus, type ErrorCodeValue } from "./errorCodes.js";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = ErrorCode.INTERNAL_ERROR,
  ) {
    super(message);
    // The concrete subclass name (e.g. "NotFoundError"), not "AppError" —
    // useful in logs; `instanceof AppError` (see isAppError) is unaffected.
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code: ErrorCodeValue | string = ErrorCode.BAD_REQUEST) {
    super(HttpStatus.BAD_REQUEST, message, code);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Invalid or expired token", code: ErrorCodeValue | string = ErrorCode.UNAUTHORIZED) {
    super(HttpStatus.UNAUTHORIZED, message, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, code: ErrorCodeValue | string = ErrorCode.FORBIDDEN) {
    super(HttpStatus.FORBIDDEN, message, code);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code: ErrorCodeValue | string = ErrorCode.NOT_FOUND) {
    super(HttpStatus.NOT_FOUND, message, code);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCodeValue | string = ErrorCode.CONFLICT) {
    super(HttpStatus.CONFLICT, message, code);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string, code: ErrorCodeValue | string = ErrorCode.PAYLOAD_TOO_LARGE) {
    super(HttpStatus.PAYLOAD_TOO_LARGE, message, code);
  }
}

/** One field-level validation failure, e.g. `{ field: "email", message: "Required" }`. */
export interface FieldError {
  field: string;
  message: string;
}

export class ValidationError extends AppError {
  constructor(
    public readonly fieldErrors: FieldError[],
    message = "Validation failed",
  ) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, message, ErrorCode.VALIDATION_ERROR);
  }
}

/** A recognized-but-unfriendly database failure. Never wraps the raw driver
 * message — see core/dbErrors.ts, which is what constructs these. */
export class DatabaseError extends AppError {
  constructor(message: string, statusCode: number = HttpStatus.BAD_REQUEST) {
    super(statusCode, message, ErrorCode.DATABASE_ERROR);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests, slow down.") {
    super(HttpStatus.TOO_MANY_REQUESTS, message, ErrorCode.RATE_LIMIT_EXCEEDED);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service temporarily unavailable.") {
    super(HttpStatus.SERVICE_UNAVAILABLE, message, ErrorCode.SERVICE_UNAVAILABLE);
  }
}

export class InternalServerError extends AppError {
  constructor(message = "Internal server error") {
    super(HttpStatus.INTERNAL_SERVER_ERROR, message, ErrorCode.INTERNAL_ERROR);
  }
}

// ── factories ────────────────────────────────────────────────────────────────
// Kept for backward compatibility: every existing call site (`throw
// badRequest(...)`, etc.) keeps working unchanged. Prefer the classes above
// in new code when you want a non-default `code` or need `instanceof`.
export const badRequest = (m: string, code?: string) => new BadRequestError(m, code);
export const unauthorized = (m?: string) => new UnauthorizedError(m);
export const forbidden = (m: string) => new ForbiddenError(m);
export const notFound = (m: string) => new NotFoundError(m);
export const conflict = (m: string) => new ConflictError(m);
export const payloadTooLarge = (m: string) => new PayloadTooLargeError(m);
export const validationError = (fieldErrors: FieldError[], message?: string) =>
  new ValidationError(fieldErrors, message);
export const rateLimitError = (m?: string) => new RateLimitError(m);
export const serviceUnavailable = (m?: string) => new ServiceUnavailableError(m);
export const internalServerError = (m?: string) => new InternalServerError(m);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
