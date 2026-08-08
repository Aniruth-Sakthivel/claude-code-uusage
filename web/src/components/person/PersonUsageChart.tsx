/**
 * One person's daily token usage, charted.
 *
 * `PersonDetail.timeseries` is a single `{day, total_tokens}[]` series — this
 * adapts it into the multi-system `Timeseries` shape `TimeseriesChart` expects
 * (as a single "Tokens" series), rather than building a second chart.
 */

import { EmptyState } from "../ui";
import { TimeseriesChart } from "../charts/TimeseriesChart";

export function PersonUsageChart({
  timeseries,
}: {
  timeseries: { day: string; total_tokens: number }[];
}) {
  if (timeseries.length === 0) {
    return <EmptyState title="No usage data in this window" />;
  }

  const data = {
    days: timeseries.map((t) => t.day),
    systems: [{ system_id: "total", display_name: "Tokens", total_tokens: 0, pct: 0 }],
    points: timeseries.map((t) => ({ day: t.day, values: { total: t.total_tokens } })),
  };

  return <TimeseriesChart data={data} />;
}
