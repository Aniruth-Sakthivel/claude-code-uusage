/** Whiteboard list + the selected board's canvas. */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { WhiteboardSummary } from "../api/types";
import { WhiteboardCanvas } from "../components/WhiteboardCanvas";
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, useToast } from "../components/ui";

export function Whiteboard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    document.title = "Whiteboard — Workspace";
  }, []);

  const q = useQuery({ queryKey: qk.boards, queryFn: () => api.get<WhiteboardSummary[]>("/workspace/boards") });

  const create = useMutation({
    mutationFn: () => api.post<WhiteboardSummary>("/workspace/boards", { name: name.trim() }),
    onSuccess: (board) => {
      qc.invalidateQueries({ queryKey: qk.boards });
      setSelected(board.id);
      setCreating(false);
      setName("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/workspace/boards/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.boards });
      setSelected(null);
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const active = q.data?.find((b) => b.id === selected);

  if (active) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="subtle" onClick={() => setSelected(null)}>
              ← All boards
            </Button>
            <h3 className="text-lg font-semibold">{active.name}</h3>
          </div>
          <Button size="sm" variant="ghost" onClick={() => remove.mutate(active.id)}>
            Delete board
          </Button>
        </div>
        <WhiteboardCanvas boardId={active.id} />
      </div>
    );
  }

  return (
    <Card>
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}>
          New board
        </Button>
      </div>
      {(q.data?.length ?? 0) === 0 ? (
        <EmptyState title="No whiteboards yet" hint="Create one for brainstorming or diagramming." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.data!.map((b) => (
            <button
              key={b.id}
              onClick={() => setSelected(b.id)}
              className="rounded-xl border border-line p-4 text-left hover:border-accent"
            >
              <div className="font-medium">{b.name}</div>
            </button>
          ))}
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="New whiteboard">
        <div className="flex flex-col gap-3">
          <Field label="Name" required>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
          </Field>
          <div className="flex justify-end">
            <Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
              Create board
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
