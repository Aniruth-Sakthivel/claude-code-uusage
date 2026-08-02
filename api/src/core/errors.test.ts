import { describe, expect, it } from "vitest";

import {
  AppError,
  badRequest,
  ConflictError,
  conflict,
  DatabaseError,
  forbidden,
  ForbiddenError,
  internalServerError,
  InternalServerError,
  isAppError,
  notFound,
  NotFoundError,
  payloadTooLarge,
  PayloadTooLargeError,
  rateLimitError,
  RateLimitError,
  serviceUnavailable,
  ServiceUnavailableError,
  unauthorized,
  UnauthorizedError,
  validationError,
  ValidationError,
  BadRequestError,
} from "./errors.js";

describe("error classes: status codes + default codes", () => {
  it.each([
    [new BadRequestError("x"), 400, "BAD_REQUEST"],
    [new UnauthorizedError(), 401, "UNAUTHORIZED"],
    [new ForbiddenError("x"), 403, "FORBIDDEN"],
    [new NotFoundError("x"), 404, "NOT_FOUND"],
    [new ConflictError("x"), 409, "CONFLICT"],
    [new PayloadTooLargeError("x"), 413, "PAYLOAD_TOO_LARGE"],
    [new RateLimitError(), 429, "RATE_LIMIT_EXCEEDED"],
    [new ServiceUnavailableError(), 503, "SERVICE_UNAVAILABLE"],
    [new InternalServerError(), 500, "INTERNAL_ERROR"],
    [new DatabaseError("x"), 400, "DATABASE_ERROR"],
  ])("%#: correct statusCode and code", (err, statusCode, code) => {
    expect((err as AppError).statusCode).toBe(statusCode);
    expect((err as AppError).code).toBe(code);
    expect(isAppError(err)).toBe(true);
  });

  it("UnauthorizedError has a sensible default message", () => {
    expect(new UnauthorizedError().message).toBe("Invalid or expired token");
  });

  it("allows overriding the default code", () => {
    const err = new BadRequestError("bad input", "CUSTOM_CODE");
    expect(err.code).toBe("CUSTOM_CODE");
  });

  it("sets .name to the concrete subclass name", () => {
    expect(new NotFoundError("x").name).toBe("NotFoundError");
  });
});

describe("ValidationError", () => {
  it("carries field-level errors", () => {
    const err = new ValidationError([{ field: "email", message: "Required" }]);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.fieldErrors).toEqual([{ field: "email", message: "Required" }]);
  });
});

describe("factory functions (backward-compat call sites)", () => {
  it("badRequest / conflict / forbidden / notFound / payloadTooLarge produce AppError instances", () => {
    for (const err of [
      badRequest("x"),
      conflict("x"),
      forbidden("x"),
      notFound("x"),
      payloadTooLarge("x"),
      unauthorized(),
      rateLimitError(),
      serviceUnavailable(),
      internalServerError(),
      validationError([]),
    ]) {
      expect(isAppError(err)).toBe(true);
    }
  });

  it("badRequest still accepts an explicit code as its 2nd argument, unchanged from before", () => {
    const err = badRequest("nope", "SPECIAL");
    expect(err.code).toBe("SPECIAL");
    expect(err.statusCode).toBe(400);
  });
});

describe("isAppError", () => {
  it("returns false for a plain Error", () => {
    expect(isAppError(new Error("boom"))).toBe(false);
  });

  it("returns false for a non-error value", () => {
    expect(isAppError("boom")).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });
});
