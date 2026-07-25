/**
 * Agent API keys.
 *
 * Key management only — enrolling a machine now lives entirely on /connect,
 * which removes the third duplicate system-creation form.
 *
 * Rotate and revoke previously had no error handling at all, so a failure was
 * completely invisible; both now report through toasts and confirm first.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { ApiKeyCreated, ApiKeyRow, SystemRow } from "../api/types";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHead,
  CodeBlock,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Eyebrow,
  Field,
  Input,
  LoadingState,
  Select,
  Table,
  Td,
  Th,
  useToast,
} from "../components/ui";
import { fmtRelative } from "../lib/format";

export function AdminKeys() {
  const qc = useQueryClient();
  const toast = useToast();

  const [systemId, setSystemId] = useState<string>("");
  const [keyName, setKeyName] = useState("");
  const [revealed, setRevealed] = useState<{ key: string; label: string } | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ApiKeyRow | null>(null);

  useEffect(() => {
    document.title = "Agent API keys — ClaudeFleet";
  }, []);

  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });

  // Default to the first system once loaded.
  const activeId = systemId || systems.data?.[0]?.system_id || "";

  const keys = useQuery({
    queryKey: qk.keys(activeId || null),
    queryFn: () => api.get<ApiKeyRow[]>(`/admin/systems/${activeId}/keys`),
    enabled: Boolean(activeId),
  });

  const invalidateKeys = () => qc.invalidateQueries({ queryKey: qk.keys(activeId) });

  const addKey = useMutation({
    mutationFn: () =>
      api.post<ApiKeyCreated>(`/admin/systems/${activeId}/keys`, {
        name: keyName.trim() || "key",
      }),
    onSuccess: (data) => {
      invalidateKeys();
      setRevealed({ key: data.api_key, label: "New key created" });
      setKeyName("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const rotate = useMutation({
    mutationFn: (keyId: number) => api.post<ApiKeyCreated>(`/admin/keys/${keyId}/rotate`),
    onSuccess: (data) => {
      invalidateKeys();
      setRevealed({ key: data.api_key, label: "Key rotated — the old one no longer works" });
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const revoke = useMutation({
    mutationFn: (keyId: number) => api.del(`/admin/keys/${keyId}`),
    onSuccess: () => {
      invalidateKeys();
      toast.push("Key revoked.");
      setPendingRevoke(null);
    },
    onError: (e: Error) => {
      toast.push(e.message, "error");
      setPendingRevoke(null);
    },
  });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Admin</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Agent API keys</h1>
        <p className="mt-1.5 max-w-2xl text-base text-muted">
          Each PC authenticates with its own key. Keys are stored hashed, so a key is only
          ever shown once — rotate it if it is lost.
        </p>
      </div>

      {revealed && (
        <Card>
          <CardHead
            title={revealed.label}
            right={
              <Button variant="subtle" size="sm" onClick={() => setRevealed(null)}>
                Done
              </Button>
            }
          />
          <Alert tone="warn" title="Copy this now">
            This is the only time the full key is shown.
          </Alert>
          <div className="mt-3">
            <CodeBlock code={revealed.key} />
          </div>
        </Card>
      )}

      {systems.isLoading ? (
        <Card>
          <LoadingState />
        </Card>
      ) : systems.isError ? (
        <Card>
          <ErrorState error={systems.error} onRetry={() => systems.refetch()} />
        </Card>
      ) : systems.data!.length === 0 ? (
        <Card>
          <EmptyState
            title="No PCs connected yet"
            hint="Connect a machine first — it gets its key automatically."
            action={
              <Link to="/connect">
                <Button size="sm">Connect a PC</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <Card>
          <CardHead title="Keys" />

          <div className="mb-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="PC">
              {(p) => (
                <Select
                  {...p}
                  value={activeId}
                  onChange={(e) => setSystemId(e.target.value)}
                >
                  {systems.data!.map((s) => (
                    <option key={s.system_id} value={s.system_id}>
                      {s.display_name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field label="New key name" hint="For your own reference.">
              {(p) => (
                <Input
                  {...p}
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="e.g. laptop-backup"
                />
              )}
            </Field>

            <Button onClick={() => addKey.mutate()} loading={addKey.isPending}>
              Create key
            </Button>
          </div>

          {keys.isLoading ? (
            <LoadingState />
          ) : keys.isError ? (
            <ErrorState error={keys.error} onRetry={() => keys.refetch()} />
          ) : (keys.data?.length ?? 0) === 0 ? (
            <EmptyState title="No keys for this PC" />
          ) : (
            <Table caption="API keys for the selected PC">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Prefix</Th>
                  <Th>Created</Th>
                  <Th>Last used</Th>
                  <Th>Status</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {keys.data!.map((k) => (
                  <tr key={k.id}>
                    <Td className="font-medium">{k.name || "—"}</Td>
                    <Td className="tnum text-ink-2">{k.prefix}…</Td>
                    <Td className="text-ink-2">{fmtRelative(k.created_at)}</Td>
                    <Td className="text-ink-2">{fmtRelative(k.last_used_at)}</Td>
                    <Td>
                      {k.active ? (
                        <Badge tone="good">Active</Badge>
                      ) : (
                        <Badge tone="critical">Revoked</Badge>
                      )}
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!k.active || rotate.isPending}
                          onClick={() => rotate.mutate(k.id)}
                        >
                          Rotate
                        </Button>
                        <Button
                          size="sm"
                          variant="subtle"
                          disabled={!k.active}
                          onClick={() => setPendingRevoke(k)}
                        >
                          Revoke
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={pendingRevoke !== null}
        title="Revoke this key?"
        body="The PC using it will stop syncing immediately until it is given a new key."
        confirmLabel="Revoke key"
        destructive
        busy={revoke.isPending}
        onConfirm={() => pendingRevoke && revoke.mutate(pendingRevoke.id)}
        onCancel={() => setPendingRevoke(null)}
      />
    </div>
  );
}
