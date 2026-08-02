/**
 * Automation rules: trigger -> action, evaluated in-process (no queue) right
 * after the PM mutation that fires them — see api/src/services/automation.ts.
 * The form's visible fields adapt to the selected trigger/action, since each
 * one needs a different, small JSON config shape.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type {
  Assignee,
  AutomationAction,
  AutomationRule,
  AutomationRun,
  AutomationTrigger,
  Channel,
  TaskStatus,
} from "../api/types";
import {
  Badge,
  Button,
  Card,
  CardHead,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  Select,
  Table,
  Td,
  Th,
  useToast,
} from "../components/ui";
import { fmtRelative } from "../lib/format";

const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  task_created: "Task created",
  task_status_changed: "Task status changed",
  task_assigned: "Task assigned",
  task_commented: "Task commented on",
};
const ACTION_LABEL: Record<AutomationAction, string> = {
  notify_user: "Notify a specific person",
  notify_assignee: "Notify the task's assignee",
  post_to_channel: "Post a chat message",
  change_task_status: "Change the task's status",
};

export function Automations() {
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<AutomationTrigger>("task_created");
  const [toStatus, setToStatus] = useState<TaskStatus>("done");
  const [action, setAction] = useState<AutomationAction>("notify_assignee");
  const [userId, setUserId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [status, setStatus] = useState<TaskStatus>("done");
  const [message, setMessage] = useState("");

  useEffect(() => {
    document.title = "Automations — Workspace";
  }, []);

  const rules = useQuery({ queryKey: qk.automations, queryFn: () => api.get<AutomationRule[]>("/workspace/automations") });
  const runs = useQuery({ queryKey: qk.automationRuns, queryFn: () => api.get<AutomationRun[]>("/workspace/automations/runs") });
  const assignees = useQuery({ queryKey: qk.assignees, queryFn: () => api.get<Assignee[]>("/pm/assignees") });
  const channels = useQuery({ queryKey: qk.channels, queryFn: () => api.get<Channel[]>("/chat/channels") });

  const resetForm = () => {
    setName("");
    setTrigger("task_created");
    setAction("notify_assignee");
    setUserId("");
    setChannelId("");
    setStatus("done");
    setToStatus("done");
    setMessage("");
  };

  const create = useMutation({
    mutationFn: () => {
      const triggerFilter = trigger === "task_status_changed" ? { to_status: toStatus } : {};
      const actionConfig: Record<string, unknown> =
        action === "notify_user"
          ? { user_id: Number(userId), message: message || undefined }
          : action === "notify_assignee"
            ? { message: message || undefined }
            : action === "post_to_channel"
              ? { channel_id: Number(channelId), message: message || undefined }
              : { status };
      return api.post<AutomationRule>("/workspace/automations", {
        name: name.trim(),
        trigger_type: trigger,
        trigger_filter: triggerFilter,
        action_type: action,
        action_config: actionConfig,
        enabled: true,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.automations });
      toast.push("Automation rule created.");
      setCreating(false);
      resetForm();
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const toggle = useMutation({
    mutationFn: (rule: AutomationRule) =>
      api.patch<AutomationRule>(`/workspace/automations/${rule.id}`, { enabled: !rule.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.automations }),
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/workspace/automations/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.automations });
      toast.push("Rule deleted.");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const needsUser = action === "notify_user";
  const needsChannel = action === "post_to_channel";
  const needsStatus = action === "change_task_status";
  const canCreate =
    name.trim() &&
    (!needsUser || userId) &&
    (!needsChannel || channelId);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>New rule</Button>
      </div>

      <Card>
        <CardHead title="Rules" />
        {rules.isLoading ? (
          <LoadingState />
        ) : rules.isError ? (
          <ErrorState error={rules.error} onRetry={() => rules.refetch()} />
        ) : (rules.data?.length ?? 0) === 0 ? (
          <EmptyState title="No automation rules yet" hint="Create one to react to task events automatically." />
        ) : (
          <Table caption="Automation rules">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>When</Th>
                <Th>Then</Th>
                <Th>Status</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rules.data!.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="text-ink-2">{TRIGGER_LABEL[r.trigger_type]}</Td>
                  <Td className="text-ink-2">{ACTION_LABEL[r.action_type]}</Td>
                  <Td>
                    <Badge tone={r.enabled ? "good" : "neutral"}>{r.enabled ? "Enabled" : "Disabled"}</Badge>
                  </Td>
                  <Td align="right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => toggle.mutate(r)}>
                        {r.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button size="sm" variant="subtle" onClick={() => remove.mutate(r.id)}>
                        Delete
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHead title="Recent runs" hint="What each rule actually did, most recent first" />
        {runs.isLoading ? (
          <LoadingState />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
        ) : (runs.data?.length ?? 0) === 0 ? (
          <EmptyState title="No automations have run yet" />
        ) : (
          <Table caption="Automation run log">
            <thead>
              <tr>
                <Th>Rule</Th>
                <Th>Status</Th>
                <Th>Detail</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {runs.data!.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.rule_name}</Td>
                  <Td>
                    <Badge tone={r.status === "ok" ? "good" : "critical"}>{r.status}</Badge>
                  </Td>
                  <Td className="text-ink-2">{r.detail}</Td>
                  <Td className="text-ink-2">{fmtRelative(r.at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={creating} onClose={() => setCreating(false)} title="New automation rule">
        <div className="flex flex-col gap-3">
          <Field label="Name" required>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
          </Field>

          <Field label="When (trigger)">
            {(p) => (
              <Select {...p} value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}>
                {(Object.keys(TRIGGER_LABEL) as AutomationTrigger[]).map((t) => (
                  <option key={t} value={t}>
                    {TRIGGER_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {trigger === "task_status_changed" && (
            <Field label="Only when status changes to" hint="Leave as-is to match any status change.">
              {(p) => (
                <Select {...p} value={toStatus} onChange={(e) => setToStatus(e.target.value as TaskStatus)}>
                  <option value="todo">Todo</option>
                  <option value="in_progress">In progress</option>
                  <option value="done">Done</option>
                </Select>
              )}
            </Field>
          )}

          <Field label="Then (action)">
            {(p) => (
              <Select {...p} value={action} onChange={(e) => setAction(e.target.value as AutomationAction)}>
                {(Object.keys(ACTION_LABEL) as AutomationAction[]).map((a) => (
                  <option key={a} value={a}>
                    {ACTION_LABEL[a]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {needsUser && (
            <Field label="Person to notify" required>
              {(p) => (
                <Select {...p} value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">Select someone…</option>
                  {assignees.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.full_name || a.email}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          {needsChannel && (
            <Field label="Channel to post to" required>
              {(p) => (
                <Select {...p} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                  <option value="">Select a channel…</option>
                  {channels.data
                    ?.filter((c) => c.kind === "channel")
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          )}

          {needsStatus && (
            <Field label="New status">
              {(p) => (
                <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                  <option value="todo">Todo</option>
                  <option value="in_progress">In progress</option>
                  <option value="done">Done</option>
                </Select>
              )}
            </Field>
          )}

          {(action === "notify_user" || action === "notify_assignee" || action === "post_to_channel") && (
            <Field label="Message" hint="Optional — defaults to the rule name and task title.">
              {(p) => <Input {...p} value={message} onChange={(e) => setMessage(e.target.value)} />}
            </Field>
          )}

          <div className="flex justify-end">
            <Button disabled={!canCreate} loading={create.isPending} onClick={() => create.mutate()}>
              Create rule
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
