/**
 * Kanban board for one initiative's tasks: three fixed columns
 * (todo/in_progress/done). No drag-and-drop and no custom columns — an
 * explicit v1 scope cut (see the plan). Moving a task between columns
 * happens inside TaskDetailModal via a button group, not by dragging.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { Task, TaskStatus } from "../api/types";
import { TaskDetailModal } from "./TaskDetailModal";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  Textarea,
  useToast,
} from "./ui";

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "Todo" },
  { status: "in_progress", label: "In progress" },
  { status: "done", label: "Done" },
];

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-line bg-surface p-3 text-left text-sm transition hover:border-accent"
    >
      <div className="font-medium">{task.title}</div>
      <div className="mt-1.5 flex items-center justify-between text-xs text-muted">
        <span>{task.due_date ?? "No due date"}</span>
        {task.comment_count > 0 && <span>{task.comment_count} comment{task.comment_count === 1 ? "" : "s"}</span>}
      </div>
    </button>
  );
}

export function TaskBoard({ initiativeId }: { initiativeId: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const q = useQuery({
    queryKey: qk.tasks(initiativeId),
    queryFn: () => api.get<Task[]>(`/initiatives/${initiativeId}/tasks`),
  });

  // Keeps the open modal's data fresh after a mutation invalidates the list.
  const liveOpenTask = openTask ? (q.data?.find((t) => t.id === openTask.id) ?? openTask) : null;

  const create = useMutation({
    mutationFn: () =>
      api.post<Task>(`/initiatives/${initiativeId}/tasks`, {
        title: title.trim(),
        description,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.tasks(initiativeId) });
      qc.invalidateQueries({ queryKey: qk.activity(initiativeId) });
      setCreating(false);
      setTitle("");
      setDescription("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const byStatus = (status: TaskStatus) => q.data!.filter((t) => t.status === status);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}>
          + Task
        </Button>
      </div>

      {q.data!.length === 0 ? (
        <EmptyState title="No tasks yet" hint="Add the first task to get this board started." />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => (
            <Card key={col.status} className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">{col.label}</h4>
                <span className="text-xs text-muted">{byStatus(col.status).length}</span>
              </div>
              {byStatus(col.status).map((t) => (
                <TaskCard key={t.id} task={t} onClick={() => setOpenTask(t)} />
              ))}
            </Card>
          ))}
        </div>
      )}

      {liveOpenTask && <TaskDetailModal task={liveOpenTask} onClose={() => setOpenTask(null)} />}

      <Modal open={creating} onClose={() => setCreating(false)} title="New task">
        <div className="flex flex-col gap-3">
          <Field label="Title" required>
            {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />}
          </Field>
          <Field label="Description" hint="Markdown supported.">
            {(p) => (
              <Textarea
                {...p}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
              />
            )}
          </Field>
          <div className="flex justify-end">
            <Button disabled={!title.trim()} loading={create.isPending} onClick={() => create.mutate()}>
              Create task
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
