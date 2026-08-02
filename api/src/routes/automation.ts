/** Automation rule management + the execution log — open to every signed-in
 * user, same posture as the rest of the PM module (see services/pm.ts). */

import type { FastifyInstance } from "fastify";

import { currentUser, requireStaff } from "../core/guards.js";
import type { AutomationRuleRow, AutomationRunRow } from "../db/schema.js";
import * as automation from "../services/automation.js";
import { automationRuleCreate, automationRuleUpdate } from "../schemas/index.js";

function ruleOut(r: AutomationRuleRow) {
  return {
    id: r.id,
    name: r.name,
    trigger_type: r.triggerType,
    trigger_filter: JSON.parse(r.triggerFilter || "{}"),
    action_type: r.actionType,
    action_config: JSON.parse(r.actionConfig || "{}"),
    enabled: r.enabled,
    created_at: r.createdAt.toISOString(),
  };
}

function runOut(r: AutomationRunRow) {
  return {
    id: r.id,
    rule_id: r.ruleId,
    rule_name: r.ruleName,
    entity_type: r.entityType,
    entity_id: r.entityId,
    status: r.status,
    detail: r.detail,
    at: r.at.toISOString(),
  };
}

export async function automationRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireStaff };

  app.get("/api/v1/workspace/automations", auth, async () => (await automation.listRules()).map(ruleOut));

  app.post("/api/v1/workspace/automations", auth, async (req, reply) => {
    const body = automationRuleCreate.parse(req.body ?? {});
    const rule = await automation.createRule(currentUser(req), body);
    return reply.code(201).send(ruleOut(rule));
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/workspace/automations/:id",
    auth,
    async (req) => {
      const body = automationRuleUpdate.parse(req.body ?? {});
      const rule = await automation.updateRule(Number(req.params.id), body);
      return ruleOut(rule);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/workspace/automations/:id",
    auth,
    async (req, reply) => {
      await automation.deleteRule(Number(req.params.id));
      return reply.code(204).send();
    },
  );

  app.get("/api/v1/workspace/automations/runs", auth, async () => (await automation.listRuns()).map(runOut));
}
