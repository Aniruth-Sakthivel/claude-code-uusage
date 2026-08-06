# Module 6 — Collaboration: docs, chat, whiteboard, meetings

**Phase 4** · ~22–28 EW

## 1. Objectives

Keep the conversation next to the work. Chat, docs and whiteboards already exist
in the current codebase and are worth porting in shape — the additions here are
version history, read state, reactions, threads and meetings.

## 2. Functional requirements

FR-50 (comments, mentions, reactions), FR-51 (docs with versions, diff, restore),
FR-52 (chat: channels, DMs, threads, reactions, read state, files), FR-53
(whiteboards), FR-54 (meetings with calendar sync).

## 3. Non-functional

| | Target |
|---|---|
| Message delivery | p95 < 500ms |
| Channel history, 100k messages | Cursor-paginated, < 300ms per page |
| Doc save | < 200ms, autosaved |
| Doc diff, 50-version history | < 1s |
| Whiteboard sync | < 200ms per operation |

## 4. UI screens

| Screen | Purpose | Primary action |
|---|---|---|
| Chat | Channel list, message pane, thread panel, composer | Send |
| Channel settings | Members, topic, archive | Save |
| Docs list | Tree by project + workspace wiki | Create |
| Doc editor | TipTap, autosave, presence, version sidebar | Edit |
| Version history | List, diff against current, restore | Restore |
| Whiteboard | Infinite canvas, notes, strokes, shapes | Draw |
| Meetings | Upcoming, agenda, attendees, notes | Schedule |
| Meeting detail | Agenda items, linked issues, notes, action items | Create action item |

## 5. User flow — a doc

```
Create in a project → autosaves every 2s while typing
Another editor opens → presence avatars appear
                     → last-write-wins with version conflict detection
                       (NOT CRDT — explicitly out of scope for v1)
Save                → doc_versions snapshot written
History             → diff any two versions, restore one
```

## 6. Database

| Table | Notes |
|---|---|
| `docs` | `workspace_id`, `project_id` **nullable** — null means a workspace wiki page. Ported decision, and a good one |
| `doc_versions` | **Full body snapshots**, not deltas — diff and restore both need them |
| `channels` | Channels and DMs in one table via `kind`. Ported; a DM is a two-member channel with a blank name |
| `channel_members`, `chat_messages` | `author_email` denormalized so a deleted user's messages still render |
| `message_reads` | `(channel_id, user_id)` → `last_read_message_id` |
| `message_reactions`, `comment_reactions` | |
| `whiteboards`, `whiteboard_elements` | `data jsonb` per element |
| `meetings`, `meeting_attendees` | |
| `calendar_connections` | OAuth tokens for Google/Outlook, encrypted at rest |

## 7. APIs

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/w/:ws/channels` · `/channels/dm` | |
| GET/POST | `/w/:ws/channels/:id/messages` | REST fallback for WebSocket |
| POST | `/w/:ws/channels/:id/read` | Advance read marker |
| POST/DELETE | `/w/:ws/messages/:id/reactions` | |
| GET/POST | `/w/:ws/docs` | `?projectId=` or wiki |
| GET/PATCH/DELETE | `/w/:ws/docs/:id` | PATCH requires `If-Match` |
| GET | `/w/:ws/docs/:id/versions` · `/versions/:v` | |
| POST | `/w/:ws/docs/:id/restore/:v` | |
| GET/POST/DELETE | `/w/:ws/boards` · `/boards/:id/elements` | |
| GET/POST | `/w/:ws/meetings` | |

**Whiteboard writes gain a REST path.** In the current design `board_op` over
WebSocket is the *only* write path, which means the whiteboard breaks entirely
when the socket is down. REST write + WS broadcast fixes that.

## 8. Components

New: `RichTextEditor` (TipTap), `Avatar`/`AvatarGroup`, `Popover` (emoji),
`Tabs`. Ported in shape: the chat pane and `WhiteboardCanvas`.

## 9. Best practices

- **Docs are last-write-wins with version conflict detection**, not CRDT.
  Real-time collaborative editing is explicitly out of scope for v1 — it is a
  quarter of work on its own and the conflict-detection path covers the actual
  failure mode.
- **Full snapshots for doc versions.** Storage is cheap; reconstructing a
  document from a delta chain to render a diff is not.
- **Denormalize the author's display name** on messages and comments, as the
  current schema already does — a deleted user must not turn a thread into rows
  of "Unknown".
- **Read state is a marker, not a per-message flag** — one row per user per
  channel rather than one per message.
- **Mentions resolve within workspace membership only**, which also prevents
  email enumeration.

## 10. Security

| Threat | Control |
|---|---|
| Reading a channel you are not in | `channel_members` checked on both REST and WS subscribe |
| A client-role user reaching workspace chat | `requireStaff` — ported decision, and the reason it exists |
| Stored XSS via doc or message body | TipTap output sanitized server-side on write, escaped on render |
| Calendar OAuth token theft | Encrypted at rest, minimum scopes, refresh handled server-side only |
| File sharing as an exfiltration path | Attachments inherit workspace scope; presigned URLs are short-lived |

## 11. Scalability

Channel history is cursor-paginated newest-first. `chat_messages` partitions
monthly past 50M rows. Whiteboard elements are capped per board (10,000) with a
clear error rather than silent degradation. Doc versions older than 12 months are
thinned to one per day.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Chat becomes a poor Slack | Scoped deliberately: no calls, no huddles, no apps. It exists to keep discussion next to work |
| Doc conflicts frustrate users | Presence indicators, 2s autosave, and a non-destructive conflict view — never a silent overwrite |
| Whiteboard breaks without WebSocket | REST write path added; WS becomes the fast path, not the only path |
| Calendar sync drifts | One-way (ours → calendar) in v1. Two-way only with evidence it is wanted |
| Version history storage growth | Thinning policy after 12 months; snapshots compressed |

## 13. Implementation order

1. Docs CRUD + TipTap editor + autosave
2. `doc_versions`, diff, restore
3. Chat: channels, messages, REST + WS
4. DMs, read state, unread counts
5. Threads and reactions
6. Whiteboard with a REST write path
7. Meetings and agendas
8. Calendar sync (Google, then Outlook)
