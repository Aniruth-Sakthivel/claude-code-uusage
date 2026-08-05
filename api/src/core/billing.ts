/**
 * Billing dates for a Claude subscription.
 *
 * Anthropic does not expose an invoice or next-payment date anywhere the agent
 * can read — `~/.claude.json` carries only when the subscription started and,
 * during a trial, when the trial ends. So:
 *
 *   - `trial_ends_at` is a real pay-by date and is reported as-is.
 *   - the renewal date is *derived* from the subscription's monthly
 *     anniversary, and is labelled an estimate everywhere it is shown.
 *
 * The estimate is wrong for annual billing, which the file gives us no way to
 * distinguish. That is why `is_estimate` travels with the value instead of the
 * UI having to remember, and why nothing here is ever presented as an amount
 * owed — this is a date to expect a charge, not a bill.
 */

export interface BillingDates {
  /** Next monthly anniversary of the subscription start, ISO date. */
  next_renewal_at: string | null;
  /** Always true for `next_renewal_at` today — see the note above. */
  is_estimate: boolean;
  /** Real pay-by date while a trial is running, ISO. Null once it has passed. */
  trial_ends_at: string | null;
  /** Whole days until the soonest of the two. Negative is never returned. */
  days_until: number | null;
}

const DAY_MS = 86_400_000;

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The next monthly anniversary of `start`, at or after `now`.
 *
 * Clamps to the last day of shorter months, so a subscription started on the
 * 31st renews on the 28th/29th in February rather than rolling into March —
 * which is what payment processors do, and what a naive `setMonth(+1)` gets
 * wrong.
 */
export function nextMonthlyAnniversary(start: Date, now: Date): Date {
  const day = start.getUTCDate();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();

  for (let i = 0; i < 2; i++) {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const candidate = new Date(
      Date.UTC(
        year,
        month,
        Math.min(day, lastDay),
        start.getUTCHours(),
        start.getUTCMinutes(),
        start.getUTCSeconds(),
      ),
    );
    if (candidate.getTime() >= now.getTime()) return candidate;
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  // Unreachable: two iterations always cross `now`. Keeps the return total.
  return new Date(Date.UTC(year, month, Math.min(day, 28)));
}

export function deriveBillingDates(
  subscriptionCreatedAt: string,
  trialEndsAt: string,
  now: Date = new Date(),
): BillingDates {
  const start = parse(subscriptionCreatedAt);
  const trialEnd = parse(trialEndsAt);
  const trialActive = trialEnd !== null && trialEnd.getTime() > now.getTime();

  const renewal = start ? nextMonthlyAnniversary(start, now) : null;

  // While a trial runs, the trial end is the date that actually matters.
  const soonest = trialActive ? trialEnd : renewal;
  const daysUntil =
    soonest === null ? null : Math.max(0, Math.ceil((soonest.getTime() - now.getTime()) / DAY_MS));

  return {
    next_renewal_at: renewal ? renewal.toISOString() : null,
    is_estimate: renewal !== null,
    trial_ends_at: trialActive ? trialEnd.toISOString() : null,
    days_until: daysUntil,
  };
}
