# Design system

Lives in `packages/ui`. No domain knowledge, no internal dependencies.

## 1. What ports verbatim

`web/src/index.css` → `packages/ui/src/theme.css`, **unchanged**.

It is a genuinely distinctive and coherent visual system, and rebuilding it would
be pure loss:

| Element | Detail |
|---|---|
| Palette | Cool slate + verdigris-teal accent + signal amber. Full CSS-variable set in `:root` and `:root[data-theme="dark"]`, so the entire theme swaps from two blocks |
| Tokens | `--plane`, `--surface`, `--surface-2`, `--ink`, `--ink-2`, `--muted`, `--grid`, `--baseline`, `--border`, `--accent`, `--accent-weak`, `--good`, `--warn`, `--critical`, `--shadow` |
| Chart series | `--pc1..--pc5`, distinct in **hue and lightness** — greyscale-safe and CVD-safe |
| Type | IBM Plex Sans / IBM Plex Mono. Compact scale `--text-2xs` (0.656rem) → `--text-2xl` (1.75rem) |
| `.tnum` | Mono + tabular figures. Exactly right for a product full of story points, hours, percentages and dates — numbers stop jittering as they change |
| `.faceplate` | Mono, uppercase, 0.09em tracking. Column headers and eyebrows |
| `.mh-table` | Row borders, zebra, hover |
| Accessibility | Global `:focus-visible` outline, `prefers-reduced-motion` block |

Tailwind v4 with **CSS-only configuration** — no `tailwind.config.js`. Keep that
decision; tokens in `@theme inline` are easier to reason about than a JS config
that has to be kept in sync with CSS variables.

Also porting unchanged: `charts/{TimeseriesChart,RankingBars,UtilizationMeter}`,
`lib/theme.tsx` (writes `document.documentElement.dataset.theme`, persists to
localStorage, falls back to `prefers-color-scheme` — deliberately not
server-stored, because it must apply before first paint), `lib/format.ts`,
`lib/useTableControls.ts`.

## 2. What ports but changes shape

### `ui.tsx` splits, one primitive per file

719 lines is fine at ~20 primitives and will not survive 40. Split into
`packages/ui/src/<Primitive>.tsx` with a barrel export.

**Prop signatures stay byte-identical** so call sites do not change.

Porting as-is: `Card`, `FormCard`, `CardHead`, `Eyebrow`, `Button` (variants
`primary|ghost|danger|subtle`, sizes `sm|md`, `loading`, forwardRef), `Field`,
`Input`, `Textarea`, `Select`, `StatusPill`, `Badge`, `Spinner`, `LoadingState`,
`EmptyState`, `ErrorState`, `Alert`, `Table`/`Th`/`Td`/`Pagination`,
`ToastProvider`/`useToast`, `CodeBlock`.

### `Modal` and `ConfirmDialog` re-base on Radix

Same props, Radix Dialog/AlertDialog underneath. Do not hand-roll focus traps,
portals and `aria-*` wiring twelve more times — that is where accessibility bugs
live.

**Both changes happen in Phase 0**, before any feature code imports
`packages/ui`. One PR, one day, no feature work in parallel. Doing it later
breaks call sites mid-flight.

## 3. What must be built

In this order — each is a dependency of the features that follow.

| Primitive | Built on | Notes |
|---|---|---|
| `Tabs` | Radix Tabs | Missing today; `InitiativeDetail.tsx` hand-rolls a tab strip. Every detail page needs it |
| `Stat` | — | Faceplate label + `.tnum` value + delta + optional sparkline. Trivial to build, used on every dashboard. Currently composed inline on each page |
| `Avatar` / `AvatarGroup` | — | Initials fallback, deterministic colour from user id |
| `Popover`, `DropdownMenu`, `Tooltip` | Radix | |
| `Combobox` | Radix + cmdk | Assignee, label and project pickers |
| `DatePicker` / `DateRangePicker` | react-day-picker | |
| `RichTextEditor` | TipTap | Mentions, slash commands, paste-image-to-upload, markdown shortcuts. Replaces `MarkdownEditor.tsx` |
| `DataGrid` | TanStack Table + react-virtual | Column resize/reorder/pin, grouping, inline edit, row selection. **The single most expensive component here** |
| `KanbanBoard` | dnd-kit + react-virtual | Virtualized columns, WIP limits, swimlanes, collapse |
| `GanttChart` | custom | CSS-grid timescale, absolutely-positioned bars, dependency arrows in one SVG overlay, virtualized rows |
| `Timeline` / `Calendar` | custom + date-fns | |
| `FileDropzone` | — | Presigned direct-to-R2, progress, resumable |

### On Gantt specifically

Build it, but **timebox to three weeks**. A dependency-aware, virtualized,
drag-resizable Gantt is genuinely 4–8 weeks and every estimate underestimates it.

Price Bryntum, DHTMLX and Syncfusion licences **before Phase 2 starts**, so the
buy-versus-build decision is not made under deadline pressure at week five.

Ship read-only first; drag-to-reschedule is a follow-up.

## 4. Conventions

- **Composition over configuration.** `<Card><CardHead/>…</Card>`, not
  `<Card title=… actions=… footer=…>`. The current `ui.tsx` already does this.
- **`forwardRef` on everything focusable**, so composition with Radix works.
- **No colour literals outside `theme.css`.** Lint-enforced — a hard-coded
  `#6366f1` breaks dark mode silently.
- **Every primitive has a Storybook story** with light and dark variants; visual
  regression runs on it.
- **Loading, empty and error are first-class states**, never afterthoughts. The
  existing `LoadingState` / `EmptyState` / `ErrorState` trio already establishes
  this; keep it universal.

## 5. Density

This product shows a lot of numbers in a little space, which is what the compact
type scale is for. Two densities:

| Mode | Row height | Use |
|---|---|---|
| Comfortable | 40px | Default |
| Compact | 32px | Power users, set per view, persisted in preferences |

## 6. Risks

| Risk | Mitigation |
|---|---|
| Design-system churn breaking call sites mid-flight | Split and Radix re-base both land in Phase 0, prop signatures preserved |
| `DataGrid` becomes a second product | Built on TanStack Table, not from scratch; scope written down before starting |
| Gantt overruns | Three-week timebox, licences priced in advance, read-only first |
| Dark mode regressions | Storybook + Chromatic on both themes for every primitive; colour-literal lint |
| Primitives accumulating domain knowledge | `packages/ui` may not import internal packages — checked in CI |
