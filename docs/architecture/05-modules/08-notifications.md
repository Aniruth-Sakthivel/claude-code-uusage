# Module 8 — Notifications

**Phase 1** · ~6 EW

## 1. Objectives

Tell people what they need to know, once, through the channel they chose —
without becoming the noise everyone mutes. A notification system that gets muted
has failed, and every product in this category has failed at it at least once.

## 2. Functional requirements

FR-80 (in-app, email, push; per-type preferences), FR-81 (digests, quiet hours).

## 3. Non-functional

| | Target |
|---|---|
| In-app delivery | p95 < 1s from the triggering mutation |
| Email delivery | Queued within 5s; provider handles the rest |
| Unread count | < 50ms, cached |
| Digest fan-out | 10,000 users within 15 minutes |

## 4. UI screens

| Screen | Purpose | Primary action |
|---|---|---|
| Bell dropdown | Recent notifications, unread badge, grouped | Mark read |
| Notification centre | Full list, filter by type and read state | Mark all read |
| Preferences | Matrix of type × channel, quiet hours, digest cadence | Save |

Port `web/src/components/NotificationsBell.tsx` in shape — the self-contained
dropdown with click-outside and Escape handling is already right.

## 5. User flow

```
Someone @mentions you in a comment
  → comment mutation + outbox event, one transaction
  → dispatcher → notifications consumer
  → preference lookup:  in-app? email? quiet hours? already notified?
  → notifications row
  → Redis publish → your bell updates live
  → email job enqueued if enabled and not in quiet hours
```

## 6. Database

| Table | Notes |
|---|---|
| `notifications` | `workspace_id`, `user_id` (cascade), `type`, `title`, `body`, `entity_type`, `entity_id`, `link`, `group_key`, `read_at`, `created_at` |
| `notification_preferences` | `(user_id, workspace_id, type)`, `in_app`, `email`, `push`, `digest_only` |
| `email_log` | Provider id, status, opens/bounces — for debugging "I never got it" |
| `push_subscriptions` | Web Push endpoint and keys |

Index `(user_id, read_at, created_at)` — ported from the current schema, where it
is already correct.

`group_key` is what makes "3 people commented on ENG-142" one row instead of
three.

## 7. APIs

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/me/notifications` | Cursor-paginated, cross-workspace |
| GET | `/api/v1/me/notifications/unread-count` | Cached |
| POST | `/api/v1/me/notifications/:id/read` | |
| POST | `/api/v1/me/notifications/read-all` | Optionally scoped to a workspace |
| GET/PATCH | `/api/v1/me/notification-preferences` | |
| POST/DELETE | `/api/v1/me/push-subscriptions` | |

## 8. Components

`Badge`, `Card`, `EmptyState`, `Table` — ported. New: `Tabs`, `Avatar`,
`Popover`.

## 9. Best practices

- **Never notify the actor about their own action.** The most common complaint
  about every tool in this category, and the cheapest to get right.
- **Group aggressively** by `group_key` — one row per entity per type per hour,
  not one per event.
- **Respect quiet hours in the user's timezone**, held in `user_profiles`.
  Deferred notifications roll into the next digest rather than arriving at 3am.
- **Every notification carries a deep link** that lands on the exact entity, not
  a list the user has to search.
- **Notification failure must never fail the mutation.** It is a consumer off the
  outbox, retried independently — which is exactly what the current inline
  implementation cannot do.

## 10. Security

| Threat | Control |
|---|---|
| Notification leaking content the recipient cannot see | Permission re-checked at **send** time, not just at trigger time |
| Email address enumeration via mention | Mentions resolve only within workspace membership |
| Notification spam as harassment | Per-actor rate limit on mention-triggered notifications |
| Push endpoint hijack | Standard Web Push encryption; endpoints scoped to a user |

The first row is subtle and important: an issue can be moved to a project the
recipient cannot see between the trigger and the send. Re-check.

## 11. Scalability

Digest fan-out is one job per workspace enqueuing one job per user, so a slow
workspace does not block others. Unread counts are cached in Redis and
invalidated on write. `notifications` partitions monthly past 50M rows.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Notification fatigue → everyone mutes | Grouping, sensible defaults (mentions and assignment on; everything else digest), a one-click "too much?" control on the bell |
| Email reputation damage from volume | Digest by default for low-priority types; monitor bounce and complaint rates; dedicated sending domain |
| Preference matrix becomes unusable | Three presets (All / Important only / Mentions only) with per-type override behind "Customize" |
| Duplicate notifications from retried jobs | Deterministic `jobId` plus a unique constraint on `(user_id, type, entity_id, group_key, hour_bucket)` |

## 13. Implementation order

1. `notifications` table, in-app delivery from the outbox consumer
2. Bell dropdown, unread count, mark read
3. Preferences with presets
4. Email channel via Resend
5. Grouping and quiet hours
6. Digests (daily/weekly)
7. Web Push
