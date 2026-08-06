# Deployment

## 1. One image, three entrypoints

```dockerfile
# infra/Dockerfile — multi-stage, pnpm, Node 22
# Final stage runs whichever entrypoint CMD selects:
#   apps/api/dist/server.js      → API + WebSocket
#   apps/worker/dist/main.js     → BullMQ consumers
#   infra/migrate.js             → migrations, run-once
```

One build, one dependency tree, one set of repository code. It also means moving
off the provider is a one-day exercise rather than a project.

## 2. Environments

| Env | Trigger | Data | Purpose |
|---|---|---|---|
| `local` | `docker compose up` | Seeded fixture | Postgres + Redis + MinIO |
| `preview` | Per PR, auto-destroyed | Seeded fixture | Review apps |
| `staging` | Merge to `main` | Anonymized production dump | Pre-production verification |
| `production` | Manual promotion from staging | | |

Production is **never** deployed directly from a merge. A human promotes a build
that has been observed in staging.

## 3. Pipeline

```
PR              → typecheck · lint · unit · TENANCY · repo · contract
                → component · visual · bundle budget · e2e · a11y
                → migration forward/back against a restored dump
                → preview environment

merge to main   → build image (tagged with the commit SHA)
                → deploy to staging
                → smoke tests
                → await manual promotion

promote         → migrate (run-once)
                → rolling deploy of api pods
                → rolling deploy of worker pods
                → smoke tests
                → auto-rollback on failure
```

## 4. Migrations — expand-contract, without exception

Pods roll gradually, so **the old image and the new schema run simultaneously**.
A migration that breaks the old code causes a partial outage for the duration of
the rollout.

```
1. Add the new column, nullable                       deploy N
2. Backfill in batches, as a job                      deploy N
3. Dual-write old and new                             deploy N
4. Switch reads to the new column                     deploy N+1
5. Stop writing the old column                        deploy N+1
6. Drop the old column                                deploy N+2
```

**Never `DROP COLUMN` in the release that stops writing it.** That is the rule
that turns a bad deploy into a rollback rather than an incident.

CI runs every migration forward and backward against a restored
production-shaped dump. A migration that cannot roll back is rejected unless it
carries a written justification.

Long backfills run as jobs, not as migrations — a migration holding a lock for
ten minutes blocks the deploy and everything else.

## 5. Zero-downtime requirements

| Requirement | Why |
|---|---|
| Migrations backward-compatible | Old and new pods coexist during a roll |
| `/ready` fails before shutdown | Load balancer drains before the process exits |
| `SIGTERM` → stop accepting, finish in flight, close sockets with 1001 | Clients reconnect cleanly to another pod |
| Workers finish the current job before exiting | Bounded by a 30s grace period, then the job is redelivered |
| WebSocket clients reconnect with backoff | And fall back to polling if they cannot |

Port the health probe split from `api/src/index.ts`: **`/live` must never touch
the database.** A slow query answering a liveness probe restarts every pod at
once — the failure mode that turns a degradation into an outage.

## 6. Rollback

| Situation | Action |
|---|---|
| Bad application code | Redeploy the previous image tag. Under 5 minutes |
| Bad migration | Roll forward with a fix. Backward migrations exist for local use and are a last resort in production |
| Bad feature | Turn off the feature flag. Seconds, no deploy |
| Data corruption | Restore from backup to a new database, verify, cut over |

Feature flags are the primary rollback mechanism for anything user-visible, which
is why they ship in Phase 0 rather than Phase 6.

## 7. Configuration

- Environment variables only; no config files in the image
- Validated at boot with Zod — a missing variable fails fast and loudly, rather
  than surfacing as a null three hours later
- Secrets in the platform's secret store, rotatable without a code change
- No environment-specific code branches beyond `NODE_ENV`

## 8. Backups

| | |
|---|---|
| Postgres | Continuous WAL archiving; point-in-time recovery to 5 minutes |
| Retention | 30 days |
| R2 | Versioning on, 30-day retention on deletes |
| Redis | Not backed up — everything in it is derived or ephemeral, by design |
| **Restore drill** | **Quarterly, automated, timed against the 1-hour RTO** |

An untested backup is not a backup. The drill is a calendar item with an owner.

## 9. Runbook

Written in Phase 0, not after the first incident. Lives in `docs/runbook/`:

- Queue backed up
- Database connections exhausted
- Redis down
- Deploy failed mid-roll
- Cross-tenant leak suspected — **containment first, investigation second**
- Data restore
- Provider outage
- On-call rotation and escalation path

A named on-call owner exists before Phase 1 ships. "The team" is not an owner.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Nobody owns operations after the move off serverless | Named owner before Phase 1; runbook in Phase 0; Bull Board, Sentry and probes from day one |
| A migration breaks a rolling deploy | Expand-contract enforced by review; forward/back tested in CI |
| Secrets sprawl across environments | One secret store per environment, rotation documented |
| Preview environments leak production data | Preview uses the seeded fixture only — never a production dump |
| Deploy cadence drops because releases are scary | Small, frequent releases behind flags; automated rollback |
| Restore has never actually been tried | Quarterly automated drill with a recorded time |
