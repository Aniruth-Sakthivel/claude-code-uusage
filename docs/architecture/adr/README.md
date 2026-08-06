# Architecture decision records

One file per decision. Each records the context, the choice, the alternatives
rejected, and — most usefully — **the criteria that would reverse it**.

An ADR without reversal criteria is an opinion with a number on it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-hosting-containers.md) | Containers, not serverless | Accepted |
| [0002](0002-tenancy-enforcement.md) | Repository-layer scope guard, not Postgres RLS | Accepted |
| [0003](0003-transactional-outbox.md) | Transactional outbox for all side-effects | Accepted |
| [0004](0004-single-issues-table.md) | One `issues` table with a type discriminator | Accepted |
| [0005](0005-search-engine.md) | Postgres FTS, not a dedicated search engine | Accepted |
| [0006](0006-lexorank-ordering.md) | LexoRank strings for board ordering | Accepted |
| [0007](0007-custom-fields-jsonb.md) | JSONB + a filterable index, not EAV | Accepted |
| [0008](0008-cursor-pagination.md) | Cursor pagination | Accepted |
| [0009](0009-uuidv7-keys.md) | UUIDv7 primary keys | Accepted |
| [0010](0010-frontend-state.md) | TanStack Query + URL + Zustand, no Redux | Accepted |
| [0011](0011-build-sso-in-house.md) | Build SAML SSO and SCIM in-house | Accepted |
| [0012](0012-build-gantt-in-house.md) | Build the Gantt chart in-house | Accepted |

## Standing constraint: no paid components

**There is no budget for licensed components or paid service tiers.** ADRs 0011
and 0012 are both consequences of it, and it applies to every future decision:
prefer open-source libraries we can host and audit, and where a build is the only
option, stage the scope so the first stage is independently useful.

Where buying would have been the better engineering choice, the ADR says so.
That is not second-guessing the constraint — it is what makes the decision cheap
to revisit if budget appears.

## Format

```
# NNNN — Title
Status · Date · Deciders

## Context      what forced a decision
## Decision     what we chose
## Alternatives what we rejected, and why
## Consequences what this costs us
## Reversal     what evidence would change this
```
