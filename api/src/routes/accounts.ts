/**
 * Claude subscription account routes.
 *
 * Two principals meet here, and they are kept strictly apart:
 *   - the agent (API key) reports what account a machine is signed into;
 *   - dashboard users (JWT) read the fleet's account picture, scoped.
 */

import type { FastifyInstance } from "fastify";

import { currentAgent, currentUser, requireAgent, requireUser } from "../core/guards.js";
import { visibleSystemIds } from "../core/rbac.js";
import { daysAgoUtc, todayUtc } from "../core/time.js";
import { writeAudit } from "../repositories/admin.js";
import { recordAccountReport } from "../repositories/accounts.js";
import { accountReportIn } from "../schemas/index.js";
import { buildAccountList, summarizeAccounts } from "../services/accounts.js";

export async function accountRoutes(app: FastifyInstance) {
  /**
   * Agent → server. Opt-in on the agent side; a machine with reporting off
   * simply never calls this.
   */
  app.post("/api/v1/account/report", { preHandler: requireAgent }, async (req) => {
    const system = currentAgent(req);
    const body = accountReportIn.parse(req.body ?? {});
    const util = body.utilization ?? null;

    const { switchedFrom } = await recordAccountReport({
      systemId: system.systemId,
      identity: body.account,
      fetchedAtMs: util?.fetched_at_ms ?? 0,
      limits: (util?.limits ?? []).map((l) => ({
        kind: l.kind,
        grp: l.group,
        scope_label: l.scope_label,
        percent: l.percent,
        severity: l.severity,
        is_active: l.is_active,
        resets_at: l.resets_at,
      })),
      dollars: util?.dollars ?? {},
    });

    // A machine quietly changing subscription is exactly the kind of event an
    // admin wants to find after the fact, so it goes in the audit log even
    // though no human initiated it.
    if (switchedFrom) {
      await writeAudit({
        actorEmail: "system",
        action: "account.switched",
        target: system.systemId,
        detail: `${switchedFrom} -> ${body.account.account_uuid}`,
      });
    }

    return { ok: true };
  });

  /** Dashboard → server. Scoped to the systems this caller may see. */
  app.get("/api/v1/accounts", { preHandler: requireUser }, async (req) => {
    const allowed = visibleSystemIds(currentUser(req));
    const accounts = await buildAccountList(allowed, todayUtc(), daysAgoUtc(6));
    return {
      accounts,
      summary: summarizeAccounts(accounts),
      scoped: allowed !== null,
    };
  });
}
