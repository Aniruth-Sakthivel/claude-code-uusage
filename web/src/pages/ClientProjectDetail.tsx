/**
 * Client portal: read-only view of one shared initiative — milestones,
 * tasks (with commenting), and docs. No create/edit/delete controls
 * anywhere on this page; the backend would reject them anyway (see
 * services/pm.ts `assertStaff`), but the UI doesn't offer them in the first
 * place rather than showing a button that 403s.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { Doc, Initiative, Milestone, Task, TaskComment } from "../api/types";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { Badge, Card, CardHead, EmptyState, ErrorState, LoadingState, Textarea, Button, useToast } from "../components/ui";
import { fmtRelative } from "../lib/format";

const STATUS_TONE = { todo: "neutral", in_progress: "accent", done: "good" } as const;
const STATUS_LABEL = { todo: "Todo", in_progress: "In progress", done: "Done" } as const;

function TaskRow({ task }: { task: Task }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");

  const comments = useQuery({
    queryKey: qk.taskComments(task.id),
    queryFn: () => api.get<TaskComment[]>(`/tasks/${task.id}/comments`),
    enabled: open,
  });

  const addComment = useMutation({
    mutationFn: () => api.post<TaskComment>(`/tasks/${task.id}/comments`, { body: comment }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.taskComments(task.id) });
      setComment("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  return (
    <div className="rounded-lg border border-line p-3">
      <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen((v) => !v)}>
        <span className="text-sm font-medium">{task.title}</span>
        <Badge tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</Badge>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
          {task.description && <p className="text-sm text-ink-2">{task.description}</p>}
          {comments.isLoading ? (
            <LoadingState />
          ) : (
            <div className="flex flex-col gap-2">
              {comments.data?.map((c) => (
                <div key={c.id} className="rounded-md bg-surface-2 p-2 text-xs">
                  <div className="mb-0.5 flex justify-between text-muted">
                    <span className="font-semibold text-ink-2">{c.author_email}</span>
                    <span>{fmtRelative(c.created_at)}</span>
                  </div>
                  {c.body}
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="Add feedback…" />
            <Button size="sm" disabled={!comment.trim()} loading={addComment.isPending} onClick={() => addComment.mutate()}>
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ClientProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const initiativeId = Number(id);

  const initiative = useQuery({
    queryKey: qk.initiative(initiativeId),
    queryFn: () => api.get<Initiative>(`/initiatives/${initiativeId}`),
    enabled: Number.isInteger(initiativeId),
  });
  const milestones = useQuery({
    queryKey: qk.milestones(initiativeId),
    queryFn: () => api.get<Milestone[]>(`/initiatives/${initiativeId}/milestones`),
  });
  const tasks = useQuery({
    queryKey: qk.tasks(initiativeId),
    queryFn: () => api.get<Task[]>(`/initiatives/${initiativeId}/tasks`),
  });
  const docs = useQuery({
    queryKey: qk.docs(initiativeId),
    queryFn: () => api.get<Doc[]>(`/initiatives/${initiativeId}/docs`),
  });

  useEffect(() => {
    document.title = initiative.data ? `${initiative.data.name} — Client Portal` : "Project — Client Portal";
  }, [initiative.data]);

  if (initiative.isLoading) return <LoadingState />;
  if (initiative.isError) return <ErrorState error={initiative.error} onRetry={() => initiative.refetch()} />;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/portal" className="mb-2 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink-2">
          <ArrowLeft className="h-4 w-4" /> All projects
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{initiative.data!.name}</h1>
        {initiative.data!.description && (
          <p className="mt-1.5 max-w-2xl text-base text-muted">{initiative.data!.description}</p>
        )}
      </div>

      <Card>
        <CardHead title="Milestones" />
        {(milestones.data?.length ?? 0) === 0 ? (
          <EmptyState title="No milestones yet" />
        ) : (
          <div className="flex flex-col gap-2">
            {milestones.data!.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-lg border border-line p-2.5 text-sm">
                <span>{m.name}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">{m.due_date ?? "No due date"}</span>
                  <Badge tone={m.status === "done" ? "good" : "neutral"}>{m.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHead title="Tasks" hint="Click a task to view details and leave feedback" />
        {tasks.isLoading ? (
          <LoadingState />
        ) : (tasks.data?.length ?? 0) === 0 ? (
          <EmptyState title="No tasks yet" />
        ) : (
          <div className="flex flex-col gap-2">
            {tasks.data!.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHead title="Documents" />
        {(docs.data?.length ?? 0) === 0 ? (
          <EmptyState title="No documents shared yet" />
        ) : (
          <div className="flex flex-col gap-4">
            {docs.data!.map((d) => (
              <div key={d.id}>
                <h4 className="mb-1.5 text-sm font-semibold">{d.title}</h4>
                <MarkdownEditor value={d.body} readOnly rows={6} />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
