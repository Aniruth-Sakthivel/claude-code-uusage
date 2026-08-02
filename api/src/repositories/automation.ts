/** Data access for automation rules and their execution log. */

import { desc, eq } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import {
  automationRules,
  automationRuns,
  type AutomationRuleRow,
  type AutomationRunRow,
} from "../db/schema.js";

export interface RuleInput {
  name: string;
  triggerType: string;
  triggerFilter: Record<string, unknown>;
  actionType: string;
  actionConfig: Record<string, unknown>;
  enabled: boolean;
}

export async function createRule(
  input: RuleInput,
  createdByUserId: number | null,
  conn: DbLike = db,
): Promise<AutomationRuleRow> {
  const rows = await conn
    .insert(automationRules)
    .values({
      name: input.name,
      triggerType: input.triggerType,
      triggerFilter: JSON.stringify(input.triggerFilter),
      actionType: input.actionType,
      actionConfig: JSON.stringify(input.actionConfig),
      enabled: input.enabled,
      createdByUserId,
    })
    .returning();
  return rows[0]!;
}

export async function listRules(conn: DbLike = db): Promise<AutomationRuleRow[]> {
  return conn.select().from(automationRules).orderBy(desc(automationRules.createdAt));
}

export async function getRule(id: number, conn: DbLike = db): Promise<AutomationRuleRow | null> {
  const rows = await conn.select().from(automationRules).where(eq(automationRules.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Enabled rules for a given trigger — the hot path, checked on every
 * matching PM mutation. */
export async function listEnabledRulesFor(
  triggerType: string,
  conn: DbLike = db,
): Promise<AutomationRuleRow[]> {
  return conn
    .select()
    .from(automationRules)
    .where(eq(automationRules.triggerType, triggerType));
}

export interface RuleUpdateInput {
  name?: string;
  triggerFilter?: Record<string, unknown>;
  actionConfig?: Record<string, unknown>;
  enabled?: boolean;
}

export async function updateRule(
  id: number,
  patch: RuleUpdateInput,
  conn: DbLike = db,
): Promise<AutomationRuleRow | null> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.triggerFilter !== undefined) values.triggerFilter = JSON.stringify(patch.triggerFilter);
  if (patch.actionConfig !== undefined) values.actionConfig = JSON.stringify(patch.actionConfig);
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  const rows = await conn.update(automationRules).set(values).where(eq(automationRules.id, id)).returning();
  return rows[0] ?? null;
}

export async function deleteRule(id: number, conn: DbLike = db): Promise<void> {
  await conn.delete(automationRules).where(eq(automationRules.id, id));
}

export interface RunLogInput {
  ruleId: number;
  ruleName: string;
  entityType: string;
  entityId: number;
  status: "ok" | "error";
  detail: string;
}

export async function logRun(input: RunLogInput, conn: DbLike = db): Promise<void> {
  await conn.insert(automationRuns).values(input);
}

export async function listRuns(limit = 100, conn: DbLike = db): Promise<AutomationRunRow[]> {
  return conn.select().from(automationRuns).orderBy(desc(automationRuns.at)).limit(limit);
}
