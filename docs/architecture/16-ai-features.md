# AI features

Folded into the phases that own the underlying data, not built as a separate
track. Every one of these is a thin service over data the outbox and search index
already produce.

## 1. Principle

**AI runs in the worker, never in the request path.** A model call is 2–30
seconds and can fail; a user waiting on it is a broken product. Every feature
below is: enqueue → job → result stored → realtime event → UI updates.

Three consequences, all deliberate:

1. Latency is invisible — the UI shows a pending state and fills in.
2. Failure is recoverable — the job retries; the user sees "couldn't generate",
   never a spinner that never ends.
3. Cost is controllable — a queue can be rate-limited and budgeted; a synchronous
   endpoint cannot.

## 2. Features by phase

| Feature | Phase | Input | Output |
|---|---|---|---|
| **Task creation from text** | 2 | A paragraph or meeting note | Draft issues with title, type, estimate — **presented for confirmation, never auto-created** |
| **Sprint planning assist** | 2 | Backlog + velocity + capacity | A suggested sprint scope with reasoning |
| **Project summary** | 3 | `activity` + `entity_versions` over a window | A paragraph for a status report |
| **Risk detection** | 3 | Velocity trend, blocked count, scope change, cycle time | Flagged projects with the specific signal |
| **Deadline prediction** | 3 | Historical cycle time by type and assignee | A confidence interval, not a single date |
| **Meeting notes** | 4 | Transcript or raw notes | Summary + action items linked to issues |
| **Doc generation** | 4 | A set of issues or a project | A draft doc |
| **Chat assistant** | 5 | A natural-language question | An answer grounded in this workspace's data |
| **Workload recommendations** | 5 | Assignments, capacity, skills | Rebalancing suggestions |

## 3. Architecture

```
trigger (user action or schedule)
  → ai queue job  (rate-limited, budgeted per workspace)
  → context assembly:  scoped queries + search_documents
  → provider call with a strict output schema
  → validate against Zod; reject and retry on mismatch
  → store as a suggestion, never as a mutation
  → outbox event → realtime → UI
```

### Context assembly is where the security lives

The context passed to a model is assembled through **the same `scoped()`
builder** every other query uses. It is a normal repository call, not a special
path — which means the poison-row suite covers it.

This matters more than it sounds: an assistant that answers "what is blocking the
Q3 launch" by querying without scope will happily summarize a project the asker
cannot see, and the leak arrives as fluent prose rather than a 403.

### Output is always a suggestion

No AI feature writes directly to a domain table. It writes an `ai_suggestions`
row that a human accepts or rejects. Accepting performs the normal mutation
through the normal service, with the normal audit trail — attributed to the user
who accepted it, with the suggestion id recorded.

## 4. Data

```
ai_suggestions(
  workspace_id, entity_type, entity_id?, kind,
  input_digest,          -- for caching and dedup
  output jsonb,          -- schema-validated
  model, tokens_in, tokens_out, cost_cents,
  status,                -- pending | accepted | rejected | failed
  created_by, created_at, resolved_at, resolved_by
)

ai_budgets(workspace_id, month, cost_cents_used, cost_cents_limit)
```

`input_digest` lets an identical request return the cached result rather than
paying twice.

## 5. Provider

Claude, via the Anthropic API, called from the worker only. Model selection per
feature: the cheapest model that passes the feature's evaluation set, not the
newest one available.

- API key server-side only, never reaching the browser
- Strict structured output — every response validated against a Zod schema, with
  a retry on mismatch rather than best-effort parsing
- Prompt and response logged with the workspace id, for debugging and cost
  attribution
- Per-workspace monthly budget, enforced before the call. Over budget → the
  feature reports it is unavailable, and does not silently degrade to a worse
  model

## 6. Privacy

| Concern | Control |
|---|---|
| Workspace data leaving the system | Disclosed explicitly; **per-workspace opt-in, default off** |
| Training on customer data | Provider configured with training disabled; stated in the DPA |
| PII in prompts | Emails and names stripped from context where the feature does not need them |
| Cross-workspace leakage | Context assembled through `scoped()`; covered by the poison-row suite |
| Audit | Every AI call logged with workspace, user, feature and cost |

Opt-in defaulting to off is the right call for an enterprise buyer, and it is far
easier to defend than retrofitting the switch after a procurement review asks
for it.

## 7. Evaluation

Each feature ships with a fixed evaluation set — 20–50 known inputs with expected
output properties — run in CI. Not "does it look good", but assertions:

- Task extraction: does it find the N tasks a human found, with under 20% false
  positives?
- Risk detection: does it flag the projects that actually slipped, in historical
  data?
- Summary: does it mention every issue that changed status in the window?

Without this, model or prompt changes silently degrade quality and nobody
notices until a user complains.

## 8. Risks

| Risk | Mitigation |
|---|---|
| **Confident wrong answers** | Everything is a suggestion requiring human acceptance. Never auto-mutate |
| Cost runaway | Per-workspace monthly budget enforced pre-call; cost recorded per suggestion; alert at 80% |
| Cross-workspace leakage via context | Context assembled through the standard scope guard; poison-row suite covers it |
| Provider outage or deprecation | Features degrade to unavailable, never to broken. Provider behind one adapter interface |
| Latency expectations | Async by design, with an explicit pending state |
| Quality regression on model change | Evaluation sets in CI, pinned model versions, deliberate upgrades |
| AI becomes the product | Every feature must justify itself against the non-AI path. If the manual flow is fine, do not add a model to it |
