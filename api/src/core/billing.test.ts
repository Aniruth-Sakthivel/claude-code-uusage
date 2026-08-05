import { describe, expect, it } from "vitest";

import { deriveBillingDates, nextMonthlyAnniversary } from "./billing.js";

const at = (iso: string) => new Date(iso);

describe("nextMonthlyAnniversary", () => {
  it("returns this month's date when it is still ahead", () => {
    const d = nextMonthlyAnniversary(at("2026-01-17T08:30:00Z"), at("2026-03-05T00:00:00Z"));
    expect(d.toISOString()).toBe("2026-03-17T08:30:00.000Z");
  });

  it("rolls to next month once this month's date has passed", () => {
    const d = nextMonthlyAnniversary(at("2026-01-17T08:30:00Z"), at("2026-03-20T00:00:00Z"));
    expect(d.toISOString()).toBe("2026-04-17T08:30:00.000Z");
  });

  it("returns today's date when the anniversary is later today", () => {
    const d = nextMonthlyAnniversary(at("2026-01-17T23:00:00Z"), at("2026-05-17T09:00:00Z"));
    expect(d.toISOString()).toBe("2026-05-17T23:00:00.000Z");
  });

  it("crosses a year boundary", () => {
    const d = nextMonthlyAnniversary(at("2025-03-09T12:00:00Z"), at("2026-12-20T00:00:00Z"));
    expect(d.toISOString()).toBe("2027-01-09T12:00:00.000Z");
  });

  /**
   * The case a naive `setMonth(month + 1)` gets wrong: it overflows the 31st
   * into the following month, reporting 3 March instead of 28 February.
   */
  it("clamps the 31st to the last day of a shorter month", () => {
    const d = nextMonthlyAnniversary(at("2026-01-31T10:00:00Z"), at("2026-02-01T00:00:00Z"));
    expect(d.toISOString()).toBe("2026-02-28T10:00:00.000Z");
  });

  it("clamps to 29 February in a leap year", () => {
    const d = nextMonthlyAnniversary(at("2024-01-31T10:00:00Z"), at("2024-02-01T00:00:00Z"));
    expect(d.toISOString()).toBe("2024-02-29T10:00:00.000Z");
  });

  it("does not permanently shift after clamping", () => {
    // February clamps to the 28th, but March must return to the 31st.
    const d = nextMonthlyAnniversary(at("2026-01-31T10:00:00Z"), at("2026-03-01T00:00:00Z"));
    expect(d.toISOString()).toBe("2026-03-31T10:00:00.000Z");
  });
});

describe("deriveBillingDates", () => {
  const now = at("2026-03-05T00:00:00Z");

  it("derives the renewal and flags it as an estimate", () => {
    const b = deriveBillingDates("2026-01-17T08:30:00Z", "", now);
    expect(b.next_renewal_at).toBe("2026-03-17T08:30:00.000Z");
    expect(b.is_estimate).toBe(true);
    expect(b.days_until).toBe(13); // 12d 8h30m, rounded up to whole days
  });

  it("prefers an active trial end over the renewal estimate", () => {
    const b = deriveBillingDates("2026-01-17T08:30:00Z", "2026-03-10T00:00:00Z", now);
    expect(b.trial_ends_at).toBe("2026-03-10T00:00:00.000Z");
    expect(b.days_until).toBe(5); // the trial, not the 17th
  });

  it("ignores a trial that has already ended", () => {
    const b = deriveBillingDates("2026-01-17T08:30:00Z", "2026-02-16T00:00:00Z", now);
    expect(b.trial_ends_at).toBeNull();
    expect(b.days_until).toBe(13); // 12d 8h30m, rounded up to whole days // back to the renewal
  });

  it("returns nulls when the subscription start is unknown", () => {
    const b = deriveBillingDates("", "", now);
    expect(b.next_renewal_at).toBeNull();
    expect(b.is_estimate).toBe(false);
    expect(b.days_until).toBeNull();
  });

  it("degrades to null on an unparseable timestamp rather than throwing", () => {
    const b = deriveBillingDates("not-a-date", "also-not-a-date", now);
    expect(b.next_renewal_at).toBeNull();
    expect(b.trial_ends_at).toBeNull();
  });

  it("never reports a negative countdown", () => {
    const b = deriveBillingDates("2026-01-17T08:30:00Z", "", at("2026-01-17T08:29:00Z"));
    expect(b.days_until).toBeGreaterThanOrEqual(0);
  });
});
