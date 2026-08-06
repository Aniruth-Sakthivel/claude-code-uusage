import { describe, expect, it } from "vitest";

import { isUuid, uuidv7, uuidv7Timestamp } from "./ids.js";

describe("uuidv7", () => {
  it("produces a well-formed UUID", () => {
    expect(isUuid(uuidv7())).toBe(true);
  });

  it("sets version 7 and the RFC variant", () => {
    const id = uuidv7();
    expect(id[14]).toBe("7"); // version nibble
    expect(["8", "9", "a", "b"]).toContain(id[19]); // variant 10xx
  });

  it("embeds the supplied timestamp", () => {
    const now = 1785989029938;
    expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
  });

  it("sorts lexicographically in creation order across milliseconds", () => {
    const ids = [uuidv7(1000), uuidv7(2000), uuidv7(3000)];
    expect([...ids].sort()).toEqual(ids);
  });

  it("sorts in creation order WITHIN a millisecond", () => {
    // The reason for the 12-bit counter. Without it these sort arbitrarily,
    // which defeats the point of choosing v7 over v4.
    const ids = Array.from({ length: 200 }, () => uuidv7(5000));
    expect([...ids].sort()).toEqual(ids);
  });

  it("does not collide over a large batch", () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => uuidv7()));
    expect(ids.size).toBe(20_000);
  });

  it("rejects non-UUID values", () => {
    for (const bad of ["", "nope", 42, null, undefined, "0199-not-a-uuid"]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});
