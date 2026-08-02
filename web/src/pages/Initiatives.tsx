/** Initiatives list — the PM module's landing page. */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { Initiative, InitiativeStatus } from "../api/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  Table,
  Td,
  Textarea,
  Th,
  useToast,
} from "../components/ui";
import { fmtRelative } from "../lib/format";

const STATUS_TONE: Record<InitiativeStatus, "neutral" | "accent" | "good" | "critical"> = {
  active: "good",
  on_hold: "neutral",
  completed: "accent",
  archived: "neutral",
};

export function Initiatives() {
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const q = useQuery({
    queryKey: qk.initiatives,
    queryFn: () => api.get<Initiative[]>("/initiatives"),
  });

  const create = useMutation({
    mutationFn: () => api.post<Initiative>("/initiatives", { name: name.trim(), description }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.initiatives });
      toast.push("Initiative created.");
      setCreating(false);
      setName("");
      setDescription("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  useEffect(() => {
    document.title = "Initiatives — Meterhouse";
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-base text-muted">
          Initiatives, tasks, milestones, and docs — open to everyone on the team.
        </p>
        <Button onClick={() => setCreating(true)}>New initiative</Button>
      </div>

      <Card>
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data!.length === 0 ? (
          <EmptyState
            title="No initiatives yet"
            hint="Create one to start tracking tasks and milestones."
            action={<Button onClick={() => setCreating(true)}>New initiative</Button>}
          />
        ) : (
          <Table caption="Initiatives with status and task counts">
            <thead>
              <tr>
                <Th>Initiative</Th>
                <Th>Status</Th>
                <Th align="right">Open tasks</Th>
                <Th align="right">Total tasks</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {q.data!.map((i) => (
                <tr key={i.id}>
                  <Td>
                    <Link to={`/workspace/initiatives/${i.id}`} className="font-semibold hover:text-accent">
                      {i.name}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[i.status]}>{i.status.replace("_", " ")}</Badge>
                  </Td>
                  <Td align="right" className="tnum text-ink-2">
                    {i.open_task_count}
                  </Td>
                  <Td align="right" className="tnum text-ink-2">
                    {i.task_count}
                  </Td>
                  <Td className="text-ink-2">{fmtRelative(i.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={creating} onClose={() => setCreating(false)} title="New initiative">
        <div className="flex flex-col gap-3">
          <Field label="Name" required>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
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
            <Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
              Create initiative
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
