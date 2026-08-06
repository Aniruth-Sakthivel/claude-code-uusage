# Frontend architecture

React 19, Vite, TypeScript strict. No Redux.

## 1. State — three tiers, strictly separated

Most frontend complexity comes from putting state in the wrong tier.

### Tier 1 — server state: TanStack Query, exclusively

Every piece of data that lives on the server is a query. Nothing is copied into
component state "so it can be edited" — that is what mutations and optimistic
updates are for.

- A query-key factory, porting and expanding `web/src/api/queryKeys.ts`
- Structural sharing on, so unchanged rows keep referential identity and don't
  re-render
- `staleTime` tuned per resource: board `0` (realtime keeps it fresh), settings
  `5min`, static lookups `Infinity`

### Tier 2 — URL state: the source of truth for view configuration

Filters, sort, grouping, active view, selected issue, open panel — all in the
URL, typed against the filter AST from [11-api.md](11-api.md).

Two properties fall out for free, and both are product features:

1. **Every view is shareable by link.** "Look at this board filtered to my P1
   bugs" is a URL, not a screenshot.
2. **Saved views are trivial** — they serialize state that already exists in a
   serializable form, rather than requiring a parallel representation.

### Tier 3 — ephemeral UI state: Zustand, one small store per feature

Drag in flight, command palette open, panel widths, multi-select. Never server
data. A store that contains an issue is a bug.

## 2. Routing

React Router v7 data router.

- **Route-level `lazy()` per module.** The board, Gantt, whiteboard and
  rich-text editor bundles must never enter the initial chunk.
- **Budget: initial JS under 180KB gzipped**, enforced in CI as a hard failure.
  Bundle size is a ratchet — without a gate it only goes one way.
- Route-level error boundaries and `<Suspense>` per module, so a Gantt crash
  shows a broken panel rather than a blank application.

```
/                                    → redirect to last workspace
/w/:slug                             → workspace home
/w/:slug/projects/:key               → project (board | list | calendar | timeline)
/w/:slug/projects/:key/issues/:key   → issue detail (modal over the list, or full page)
/w/:slug/my-work
/w/:slug/docs/:id  · /chat/:id · /reports · /settings/*
/portal/:slug                        → client portal, separate shell
```

The issue detail rendering as a modal over the list **and** as a full page from a
deep link is deliberate — it is how Linear and Jira both work, and it needs to be
designed in rather than retrofitted.

## 3. Data fetching

`apps/web/src/features/<module>/api/` holds typed hooks generated against
`packages/contracts`. No hand-written response types — that is what drifts.

- Infinite queries for every cursor-paginated list
- Prefetch on hover for issue rows and project links, which makes navigation
  feel instant for the cost of one speculative request
- A single `setUnauthorizedHandler` for token expiry, ported from
  `web/src/auth/AuthContext.tsx`

## 4. Optimistic updates

```
onMutate   → cancel in-flight queries, snapshot, apply locally
onError    → roll back to the snapshot, toast
onSettled  → invalidate
```

Every mutation sends `If-Match: version`. On `412` the client refetches and
shows a **non-destructive** conflict notice with the current server state — never
a silent overwrite, and never a lost edit.

Realtime events reconcile by version comparison
([12-realtime-jobs.md](12-realtime-jobs.md)), so an optimistic local write and
the inbound echo of that same write converge instead of fighting.

## 5. Performance

| Technique | Where | Target |
|---|---|---|
| `@tanstack/react-virtual` | List and table views | 10,000 rows, 60fps |
| Virtualization **per Kanban column** | Board | 2,000 cards renders ~20 |
| Windowed date range | Gantt | Only visible weeks rendered |
| `content-visibility: auto` | Long doc pages | |
| Debounced cache writes | Realtime | 50ms coalescing, so a bulk edit doesn't cause 500 renders |
| Route-level code splitting | Everywhere | <180KB initial |

## 6. Drag and drop

`@dnd-kit/core` + `@dnd-kit/sortable`. Not `react-beautiful-dnd` — unmaintained,
no React 19 support.

A drop computes a **LexoRank midpoint client-side**, applies it optimistically,
and sends one `PATCH`. No server round trip to learn the new position, and no
reindexing of siblings.

Keyboard-accessible drag is a requirement, not a nice-to-have (WCAG 2.1 AA) —
dnd-kit supports it natively, which is part of why it wins.

## 7. Keyboard

A single scoped hotkey registry: `global | list | detail | modal | editor`, where
a modal scope suppresses the ones outside it.

| Key | Action |
|---|---|
| `⌘K` | Command palette |
| `/` | Search |
| `c` | Create issue |
| `g p` `g i` `g b` | Go to projects / issues / board |
| `e` | Edit |
| `x` | Select (then `⌘A`, shift-click ranges) |
| `⌘⏎` | Submit |
| `?` | Shortcut sheet |

**Every action registers once** and appears automatically in both the command
palette and the `?` sheet. Port `web/src/components/CommandPalette.tsx` as the
discovery surface — a shortcut nobody can find is a shortcut that does not exist.

## 8. Realtime integration

```tsx
useRealtimeSubscription(`project:${projectId}`);
// on event:
//   if (event.version <= cached.version) return;   // stale echo, drop
//   queryClient.setQueryData(key, applyPatch);
```

The connection is one per session, held in a context provider — ported in shape
from `web/src/context/RealtimeContext.tsx`. Subscriptions are reference-counted,
so leaving a board unsubscribes it.

A visible connection indicator, with three states: live, reconnecting, polling.

## 9. Forms

`react-hook-form` + `zodResolver` against the **same** `packages/contracts`
schema the API validates with. One schema, so client and server validation
cannot disagree.

Server field errors (`errors: [{field, message}]`) map straight onto form fields.

## 10. Testing

Currently zero frontend tests across 11,525 lines. That does not survive a 10×
larger UI with DnD, virtualization and realtime — the three hardest things to
verify by eye.

| Level | Tool | Scope |
|---|---|---|
| Unit | Vitest | Filter-AST parser, LexoRank arithmetic, reducers, hooks |
| Component | RTL | Design system primitives, complex components |
| Visual | Storybook + Chromatic | Every primitive, light and dark |
| E2E | Playwright | 12–15 critical journeys |
| A11y | axe-core in Playwright | Every route |

CI gate: no merge without green. Established in Phase 0 with 5 flows, grown every
phase.

## 11. Accessibility

WCAG 2.1 AA, treated as a requirement rather than an audit item:

- Radix primitives for anything with focus management — do not hand-roll focus
  traps and `aria-*` forty times
- Keyboard-accessible drag and drop
- Visible focus rings (the ported `:focus-visible` block already does this)
- `prefers-reduced-motion` honoured (already in the ported CSS)
- Live regions for realtime updates and toasts
- Colour contrast checked in CI; the ported chart palette is already CVD-safe
  and distinguishable in greyscale

## 12. Risks

| Risk | Mitigation |
|---|---|
| Bundle growth | CI budget as a hard fail, per-route splitting, bundle analyzer in PRs |
| Realtime/optimistic races | Version-based reconciliation, deterministic out-of-order tests |
| Virtualization breaks find-in-page and a11y | Aria row counts, a "load all" escape for print/export |
| Zustand stores accumulate server data | Lint rule banning query-shaped types in stores; code review |
| URL state grows unreadable | Long filters compressed to a short id backed by a saved view |
| DataGrid becomes a second product | Timeboxed; built on TanStack Table rather than from scratch |
