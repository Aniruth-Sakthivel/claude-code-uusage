/**
 * Automation: trigger -> action rules, evaluated in-process right after the
 * PM mutation that fired them commits — never inside that mutation's own
 * transaction, so a misconfigured rule (bad channel id, etc.) can never roll
 * back or block the task/comment/etc. that triggered it. Mirrors the
 * Python agent's account-reporting pattern: runs after the main write,
 * swallows its own errors, never costs the caller anything.
 *
 * Actions call repositories directly, never services/pm.ts's public
 * functions — so an action can never itself trigger another automation run.
 * Automations are exactly one hop deep by construction; no cycle detection
 * needed because there is no path back into `runAutomations`.
 */

import { badRequest, notFound } from "../core/errors.js";
import type { Principal } from "../core/rbac.js";
import * as automationRepo from "../repositories/automation.js";
import * as chatRepo from "../repositories/chat.js";
import * as notifyRepo from "../repositories/notifications.js";
import * as pmRepo from "../repositories/pm.js";
import type { AutomationRuleRow } from "../db/schema.js";

export type TriggerType = "task_created" | "task_status_changed" | "task_assigned" | "task_commented";
export type ActionType = "notify_user" | "notify_assignee" | "post_to_channel" | "change_task_status";

export interface TriggerContext {
  taskId: number;
  initiativeId: number;
  title: string;
  fromStatus?: string;
  toStatus?: string;
  assigneeUserId?: number | null;
  commentBody?: string;
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function matchesFilter(rule: AutomationRuleRow, ctx: TriggerContext): boolean {
  const filter = parseJson(rule.triggerFilter);
  if (rule.triggerType === "task_status_changed" && typeof filter.to_status === "string") {
    return ctx.toStatus === filter.to_status;
  }
  return true; // no filter fields defined for this trigger type yet
}

async function runAction(rule: AutomationRuleRow, ctx: TriggerContext): Promise<string> {
  const config = parseJson(rule.actionConfig);
  const link = `/workspace/initiatives/${ctx.initiativeId}`;

  switch (rule.actionType) {
    case "notify_user": {
      const userId = Number(config.user_id);
      if (!Number.isInteger(userId)) throw new Error("notify_user: missing user_id");
      await notifyRepo.createNotification({
        userId,
        type: "automation",
        title: typeof config.message === "string" ? config.message : rule.name,
        body: ctx.title,
        entityType: "task",
        entityId: ctx.taskId,
        link,
      });
      return `notified user ${userId}`;
    }
    case "notify_assignee": {
      if (!ctx.assigneeUserId) return "skipped: task has no assignee";
      await notifyRepo.createNotification({
        userId: ctx.assigneeUserId,
        type: "automation",
        title: typeof config.message === "string" ? config.message : rule.name,
        body: ctx.title,
        entityType: "task",
        entityId: ctx.taskId,
        link,
      });
      return `notified assignee ${ctx.assigneeUserId}`;
    }
    case "post_to_channel": {
      const channelId = Number(config.channel_id);
      if (!Number.isInteger(channelId)) throw new Error("post_to_channel: missing channel_id");
      const message =
        typeof config.message === "string" && config.message.trim()
          ? config.message
          : `${rule.name}: "${ctx.title}"`;
      await chatRepo.createMessage(channelId, null, "Automation", message);
      return `posted to channel ${channelId}`;
    }
    case "change_task_status": {
      const status = config.status;
      if (status !== "todo" && status !== "in_progress" && status !== "done") {
        throw new Error("change_task_status: invalid status");
      }
      await pmRepo.updateTask(ctx.taskId, { status });
      return `set task status to ${status}`;
    }
    default:
      throw new Error(`unknown action type: ${rule.actionType}`);
  }
}

/** Fire-and-forget from the caller's perspective: never throws. Each rule's
 * outcome — including failure — is written to `automation_runs`. */
export async function runAutomations(trigger: TriggerType, ctx: TriggerContext): Promise<void> {
  const rules = await automationRepo.listEnabledRulesFor(trigger);
  for (const rule of rules) {
    if (!rule.enabled || !matchesFilter(rule, ctx)) continue;
    try {
      const detail = await runAction(rule, ctx);
      await automationRepo.logRun({
        ruleId: rule.id,
        ruleName: rule.name,
        entityType: "task",
        entityId: ctx.taskId,
        status: "ok",
        detail,
      });
    } catch (err) {
      await automationRepo.logRun({
        ruleId: rule.id,
        ruleName: rule.name,
        entityType: "task",
        entityId: ctx.taskId,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── rule management ──────────────────────────────────────────────────────────
const VALID_TRIGGERS: TriggerType[] = ["task_created", "task_status_changed", "task_assigned", "task_commented"];
const VALID_ACTIONS: ActionType[] = ["notify_user", "notify_assignee", "post_to_channel", "change_task_status"];

export interface RuleCreateInput {
  name: string;
  trigger_type: string;
  trigger_filter: Record<string, unknown>;
  action_type: string;
  action_config: Record<string, unknown>;
  enabled: boolean;
}

export async function createRule(actor: Principal, input: RuleCreateInput) {
  if (!VALID_TRIGGERS.includes(input.trigger_type as TriggerType)) throw badRequest("Unknown trigger type");
  if (!VALID_ACTIONS.includes(input.action_type as ActionType)) throw badRequest("Unknown action type");
  return automationRepo.createRule(
    {
      name: input.name,
      triggerType: input.trigger_type,
      triggerFilter: input.trigger_filter,
      actionType: input.action_type,
      actionConfig: input.action_config,
      enabled: input.enabled,
    },
    actor.id,
  );
}

export function listRules() {
  return automationRepo.listRules();
}

export interface RuleUpdateInput {
  name?: string;
  trigger_filter?: Record<string, unknown>;
  action_config?: Record<string, unknown>;
  enabled?: boolean;
}

export async function updateRule(id: number, patch: RuleUpdateInput) {
  const existing = await automationRepo.getRule(id);
  if (!existing) throw notFound("Rule not found");
  const rule = await automationRepo.updateRule(id, {
    name: patch.name,
    triggerFilter: patch.trigger_filter,
    actionConfig: patch.action_config,
    enabled: patch.enabled,
  });
  return rule!;
}

export async function deleteRule(id: number) {
  if (!(await automationRepo.getRule(id))) throw notFound("Rule not found");
  await automationRepo.deleteRule(id);
}

export function listRuns() {
  return automationRepo.listRuns();
}
