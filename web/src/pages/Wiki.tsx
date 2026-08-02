/**
 * Workspace wiki: docs not tied to any single initiative (`docs.initiative_id
 * IS NULL`) — general knowledge base pages, as opposed to the per-initiative
 * Docs tab on InitiativeDetail.tsx. Same editor, different scope.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { Doc } from "../api/types";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { Button, Card, EmptyState, ErrorState, Input, LoadingState, useToast } from "../components/ui";
import { fmtRelative } from "../lib/format";

export function Wiki() {
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    document.title = "Wiki — Workspace";
  }, []);

  const q = useQuery({ queryKey: qk.wiki, queryFn: () => api.get<Doc[]>("/workspace/docs") });
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.wiki });

  const create = useMutation({
    mutationFn: () => api.post<Doc>("/workspace/docs", { title: newTitle.trim(), body: "" }),
    onSuccess: (doc) => {
      invalidate();
      setCreating(false);
      setNewTitle("");
      setSelected(doc.id);
      setBody("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const save = useMutation({
    mutationFn: (docId: number) => api.patch<Doc>(`/docs/${docId}`, { body }),
    onSuccess: () => {
      invalidate();
      toast.push("Page saved.");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const remove = useMutation({
    mutationFn: (docId: number) => api.del(`/docs/${docId}`),
    onSuccess: () => {
      invalidate();
      setSelected(null);
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const doc = q.data?.find((d) => d.id === selected);

  useEffect(() => {
    if (doc) setBody(doc.body);
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  if (doc) {
    return (
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <Button size="sm" variant="subtle" onClick={() => setSelected(null)}>
            ← All pages
          </Button>
          <Button size="sm" variant="ghost" onClick={() => remove.mutate(doc.id)}>
            Delete page
          </Button>
        </div>
        <h3 className="mb-3 text-lg font-semibold">{doc.title}</h3>
        <MarkdownEditor value={body} onChange={setBody} rows={16} />
        {body !== doc.body && (
          <div className="mt-3 flex justify-end">
            <Button loading={save.isPending} onClick={() => save.mutate(doc.id)}>
              Save
            </Button>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          New page
        </Button>
      </div>
      {creating && (
        <div className="mb-4 flex gap-2">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Page title"
            autoFocus
          />
          <Button disabled={!newTitle.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        </div>
      )}
      {(q.data?.length ?? 0) === 0 ? (
        <EmptyState title="No wiki pages yet" hint="Notes, specs, or anything worth writing down." />
      ) : (
        <div className="flex flex-col gap-2">
          {q.data!.map((d) => (
            <button
              key={d.id}
              onClick={() => setSelected(d.id)}
              className="rounded-lg border border-line p-3 text-left text-sm hover:border-accent"
            >
              <div className="font-medium">{d.title}</div>
              <div className="mt-0.5 text-xs text-muted">Updated {fmtRelative(d.updated_at)}</div>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
