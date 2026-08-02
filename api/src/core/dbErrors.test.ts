import { describe, expect, it } from "vitest";

import { mapDatabaseError } from "./dbErrors.js";

describe("mapDatabaseError", () => {
  it("returns null for a non-pg-shaped error", () => {
    expect(mapDatabaseError(new Error("plain error"))).toBeNull();
    expect(mapDatabaseError("just a string")).toBeNull();
    expect(mapDatabaseError(null)).toBeNull();
    expect(mapDatabaseError({ code: "not-5-chars" })).toBeNull();
  });

  it("maps unique_violation (23505) to a friendly 409, never leaking the raw message", () => {
    // Real pg errors always carry `.table` alongside `.constraint` — Postgres's
    // default naming convention is `<table>_<column>_key`.
    const pgErr = {
      code: "23505",
      table: "users",
      constraint: "users_email_key",
      message: 'duplicate key value violates unique constraint "users_email_key"',
    };
    const mapped = mapDatabaseError(pgErr);
    expect(mapped).not.toBeNull();
    expect(mapped!.statusCode).toBe(409);
    expect(mapped!.code).toBe("CONFLICT");
    expect(mapped!.message).toBe("Email already exists.");
    expect(mapped!.message).not.toContain("constraint");
  });

  it("maps foreign_key_violation (23503) to a friendly 400", () => {
    const mapped = mapDatabaseError({ code: "23503", constraint: "fk_project_owner" });
    expect(mapped!.statusCode).toBe(400);
    expect(mapped!.message).toBe("Referenced record not found.");
  });

  it.each(["23514", "23502", "22P02", "22001"])(
    "maps constraint/type error %s to 'Invalid data.'",
    (code) => {
      const mapped = mapDatabaseError({ code });
      expect(mapped!.statusCode).toBe(400);
      expect(mapped!.message).toBe("Invalid data.");
    },
  );

  it.each(["40001", "40P01"])("maps transient conflict %s to a retryable message", (code) => {
    const mapped = mapDatabaseError({ code });
    expect(mapped!.message).toMatch(/try again/i);
  });

  it("falls back to a generic safe message for an unrecognized SQLSTATE", () => {
    const mapped = mapDatabaseError({ code: "99999", message: "some internal driver detail" });
    expect(mapped).not.toBeNull();
    expect(mapped!.message).toBe("A database error occurred.");
    expect(mapped!.message).not.toContain("internal driver detail");
  });

  it("falls back to 'value' when no constraint/column name is present", () => {
    const mapped = mapDatabaseError({ code: "23505" });
    expect(mapped!.message).toBe("Value already exists.");
  });
});
