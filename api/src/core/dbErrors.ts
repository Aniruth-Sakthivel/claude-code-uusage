/**
 * Maps raw Postgres driver errors to safe, user-facing AppErrors.
 *
 * `pg` error objects carry the driver's own message (can include column/table/
 * constraint names) plus a 5-character SQLSTATE `code`. We only ever forward
 * the SQLSTATE-derived friendly message to the client — the raw `err.message`
 * is logged server-side (by the caller, via `req.log`) but never sent back.
 *
 * Reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

import { AppError, BadRequestError, ConflictError, DatabaseError } from "./errors.js";

interface PgErrorLike {
  code: string;
  constraint?: string;
  table?: string;
  column?: string;
}

function isPgErrorLike(e: unknown): e is PgErrorLike {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as { code: unknown }).code === "string" &&
    /^[0-9A-Z]{5}$/.test((e as { code: string }).code)
  );
}

/**
 * Turns a Postgres constraint name into a human label. Postgres's default
 * naming convention is `<table>_<column>_key` (e.g. `users_email_key`), so
 * the table name (which pg always reports separately as `err.table`) is
 * stripped first — without that, "users_email_key" would read as "Users
 * email" instead of "Email".
 */
function friendlyFieldLabel(err: PgErrorLike): string {
  let raw = err.constraint ?? "";
  if (err.table && raw.startsWith(`${err.table}_`)) {
    raw = raw.slice(err.table.length + 1);
  }
  raw = raw.replace(/^(uq_|fk_|idx_)/, "").replace(/_key$|_unique$|_fkey$/, "");
  if (!raw) raw = err.column ?? "value";
  return raw
    .split("_")
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Returns a safe {@link AppError} for a recognized Postgres SQLSTATE, or
 * `null` if `err` isn't a pg error / isn't one we have a mapping for — callers
 * should fall through to a generic 500 in that case, not assume `null` means
 * "no error".
 */
export function mapDatabaseError(err: unknown): AppError | null {
  if (!isPgErrorLike(err)) return null;

  switch (err.code) {
    case "23505": // unique_violation
      return new ConflictError(`${friendlyFieldLabel(err)} already exists.`);
    case "23503": // foreign_key_violation
      return new BadRequestError("Referenced record not found.");
    case "23514": // check_violation
    case "23502": // not_null_violation
    case "22P02": // invalid_text_representation
    case "22001": // string_data_right_truncation (value too long)
      return new BadRequestError("Invalid data.");
    case "40001": // serialization_failure
    case "40P01": // deadlock_detected
      return new DatabaseError("The request could not be completed. Please try again.");
    default:
      // A real pg error (5-char SQLSTATE) we don't have a specific friendly
      // mapping for yet — still never leak err.message to the client.
      return new DatabaseError("A database error occurred.");
  }
}
