/**
 * One system (PC), as a card.
 *
 * Two modes from the same component: full (used on the Systems management
 * page — scan activity, owner, environment, projects, and admin actions) and
 * compact (used on the Overview dashboard — a read-only glance, no actions).
 */

import type { SystemRow } from "../../api/types";
import { Avatar } from "../Avatar";
import { ScanActivity } from "../ScanActivity";
import { Button, Card, StatusPill } from "../ui";
import { fmtRelative, fmtTokens, systemColor } from "../../lib/format";

export function SystemCard({
  system: s,
  colorIndex = 0,
  compact = false,
  onEdit,
  onManage,
  onRemove,
}: {
  system: SystemRow;
  colorIndex?: number;
  compact?: boolean;
  onEdit?: () => void;
  onManage?: () => void;
  onRemove?: () => void;
}) {
  const hasActions = !compact && (onEdit || onManage || onRemove);

  return (
    <Card className="h-full">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ background: systemColor(colorIndex) }}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink">{s.display_name}</div>
            <div className="truncate text-xs text-muted">{s.hostname || "—"}</div>
          </div>
        </div>
        <StatusPill status={s.status} neverSynced={s.never_synced} health={s.health} reason={s.reason} />
      </div>

      {!compact && s.active_sessions > 0 && (
        <div className="mt-1 text-xs text-muted">
          {s.active_sessions} session{s.active_sessions === 1 ? "" : "s"} open
        </div>
      )}

      {!compact && (
        <div className="mt-3">
          <ScanActivity scan={s} neverReported={s.never_synced} />
        </div>
      )}

      {!compact && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-2">
          {s.owner ? (
            <div className="flex items-center gap-1.5">
              <Avatar label={s.owner} />
              <span className="truncate">{s.owner}</span>
            </div>
          ) : (
            <span className="text-muted">No owner</span>
          )}
          {s.environment && <span className="text-muted">{s.environment}</span>}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-3">
        <div className="rounded-lg bg-surface-2 py-2">
          <div className="tnum text-sm font-semibold text-ink">{fmtTokens(s.total_tokens)}</div>
          <div className="text-2xs text-muted">tracked</div>
        </div>
        <div className="rounded-lg bg-surface-2 py-2">
          <div className="tnum text-sm font-semibold text-ink">{s.sessions}</div>
          <div className="text-2xs text-muted">sessions</div>
        </div>
        {!compact && (
          <div className="rounded-lg bg-surface-2 py-2">
            <div className="tnum text-sm font-semibold text-ink">{s.projects}</div>
            <div className="text-2xs text-muted">projects</div>
          </div>
        )}
      </div>

      <div className="mt-2 text-2xs text-muted">
        Last {compact ? "seen" : "sync"}{" "}
        {s.never_synced ? "never" : fmtRelative(compact ? s.last_seen_at : s.last_sync_at)}
      </div>

      {hasActions && (
        <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-line pt-3">
          {onEdit && (
            <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${s.display_name}`}>
              Edit
            </Button>
          )}
          {onManage && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onManage}
              aria-label={`Agent controls for ${s.display_name}`}
            >
              Agent controls
            </Button>
          )}
          {onRemove && (
            <Button
              size="sm"
              variant="subtle"
              onClick={onRemove}
              aria-label={`Remove ${s.display_name}`}
            >
              Remove
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
