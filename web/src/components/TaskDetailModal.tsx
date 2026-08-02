/**
 * Task detail: title/description, status changer, assignee + due date, and a
 * comment thread. Opened from TaskBoard.
 *
 * Status changes are a button group, not drag-and-drop — an explicit v1 scope
 * cut (see the plan): no DnD library dependency, no position/ordering column.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { Assignee, Task, TaskComment, TaskStatus } from "../api/types";
import { fmtRelative } from "../lib/format";
import { MarkdownEditor } from "./MarkdownEditor";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  Select,
  Textarea,
  useToast,
} from "./ui";

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
};

export function TaskDetailModal({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [description, setDescription] = useState(task.description);
  const [comment, setComment] = useState("");
  const [pendingDelete, setPendingDelete] = useState(false);

  const invalidateTask = () => {
    qc.invalidateQueries({ queryKey: qk.tasks(task.initiative_id) });
    qc.invalidateQueries({ queryKey: qk.activity(task.initiative_id) });
  };

  const assignees = useQuery({
    queryKey: qk.assignees,
    queryFn: () => api.get<Assignee[]>("/pm/assignees"),
  });

  const comments = useQuery({
    queryKey: qk.taskComments(task.id),
    queryFn: () => api.get<TaskComment[]>(`/tasks/${task.id}/comments`),
  });

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch<Task>(`/tasks/${task.id}`, patch),
    onSuccess: invalidateTask,
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const addComment = useMutation({
    mutationFn: () => api.post<TaskComment>(`/tasks/${task.id}/comments`, { body: comment }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.taskComments(task.id) });
      invalidateTask();
      setComment("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/tasks/${task.id}`),
    onSuccess: () => {
      invalidateTask();
      toast.push("Task deleted.");
      onClose();
    },
    onError: (e: Error) => {
      toast.push(e.message, "error");
      setPendingDelete(false);
    },
  });

  return (
    <Modal open onClose={onClose} title={task.title}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap gap-2">
          {(["todo", "in_progress", "done"] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={task.status === s ? "primary" : "ghost"}
              loading={update.isPending && update.variables?.status === s}
              onClick={() => update.mutate({ status: s })}
            >
              {STATUS_LABEL[s]}
            </Button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Assignee">
            {(p) => (
              <Select
                {...p}
                value={task.assignee_user_id ?? ""}
                onChange={(e) =>
                  update.mutate({
                    assignee_user_id: e.target.value ? Number(e.target.value) : null,
                  })
                }
              >
                <option value="">Unassigned</option>
                {assignees.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.full_name || a.email}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Due date">
            {(p) => (
              <input
                {...p}
                type="date"
                className="h-11 w-full rounded-lg border border-line bg-surface-2 px-3 text-base text-ink"
                value={task.due_date ?? ""}
                onChange={(e) => update.mutate({ due_date: e.target.value || null })}
              />
            )}
          </Field>
        </div>

        <div>
          <div className="mb-1.5 text-xs font-semibold text-ink-2">Description</div>
          <MarkdownEditor value={description} onChange={setDescription} rows={5} />
          {description !== task.description && (
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                loading={update.isPending && update.variables?.description !== undefined}
                onClick={() => update.mutate({ description })}
              >
                Save description
              </Button>
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold text-ink-2">
            Comments {task.comment_count > 0 && `(${task.comment_count})`}
          </div>
          {comments.isLoading ? (
            <LoadingState />
          ) : comments.isError ? (
            <ErrorState error={comments.error} onRetry={() => comments.refetch()} />
          ) : (
            <div className="flex flex-col gap-3">
              {(comments.data?.length ?? 0) === 0 ? (
                <EmptyState title="No comments yet" />
              ) : (
                comments.data!.map((c) => (
                  <div key={c.id} className="rounded-lg border border-line p-3">
                    <div className="mb-1 flex items-baseline justify-between text-xs text-muted">
                      <span className="font-semibold text-ink-2">{c.author_email || "—"}</span>
                      <span>{fmtRelative(c.created_at)}</span>
                    </div>
                    <div className="text-sm">{c.body}</div>
                  </div>
                ))
              )}

              <div className="flex flex-col gap-2">
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Add a comment…"
                  rows={3}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={!comment.trim()}
                    loading={addComment.isPending}
                    onClick={() => addComment.mutate()}
                  >
                    Comment
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-line pt-4">
          <Button size="sm" variant="subtle" onClick={() => setPendingDelete(true)}>
            Delete task
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete}
        title="Delete this task?"
        body="This cannot be undone — its comments are deleted with it."
        confirmLabel="Delete task"
        destructive
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setPendingDelete(false)}
      />
    </Modal>
  );
}
