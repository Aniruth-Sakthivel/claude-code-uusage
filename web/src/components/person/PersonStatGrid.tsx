/**
 * The stat grid shared by the Sessions master-detail panel and the admin
 * User Details page's Overview tab.
 */

import type { PersonRow } from "../../api/types";
import { fmtRelative, fmtTokens } from "../../lib/format";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="faceplate text-2xs text-muted">{label}</div>
      <div className="tnum mt-1 text-lg font-semibold text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-2xs text-muted">{hint}</div>}
    </div>
  );
}

export function PersonStatGrid({
  person,
  projectCount,
  range,
}: {
  person: PersonRow;
  projectCount: number;
  range: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Tokens" value={fmtTokens(person.tokens_range)} hint={`${range} window`} />
      <Stat label="Today" value={fmtTokens(person.tokens_today)} />
      <Stat label="Sessions" value={String(person.sessions)} />
      <Stat
        label="Prompts"
        value={person.prompts === null ? "—" : String(person.prompts)}
        hint={person.prompts === null ? "not collected yet" : undefined}
      />
      <Stat label="Projects" value={String(projectCount)} />
      <Stat label="PCs" value={String(person.system_count)} />
      <Stat label="Last active" value={fmtRelative(person.last_active)} />
      <Stat label="Account" value={person.plan_label ?? "—"} />
    </div>
  );
}
