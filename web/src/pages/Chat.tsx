/**
 * Team chat: channels + 1:1 DMs. Real-time delivery goes over the existing
 * dashboard WebSocket (see lib/ws.ts `sendChat`/`onChatMessage`) when it's
 * connected; REST (`POST /chat/channels/:id/messages`) is the fallback for
 * sending, and is always used for history — see routes/chat.ts.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Send, User as UserIcon } from "lucide-react";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { Assignee, Channel, ChatMessage } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { useRealtime } from "../context/RealtimeContext";
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingState,
  Modal,
  Select,
  Textarea,
  useToast,
} from "../components/ui";
import { fmtRelative } from "../lib/format";

function channelLabel(c: Channel, myId: number | undefined, assignees: Assignee[] | undefined) {
  if (c.kind === "channel") return c.name || "Untitled channel";
  const otherId = c.member_ids.find((id) => id !== myId);
  const other = assignees?.find((a) => a.id === otherId);
  return other?.full_name || other?.email || "Direct message";
}

export function Chat() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { onChatMessage, sendChat } = useRealtime();
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState<"channel" | "dm" | null>(null);
  const [newChannelName, setNewChannelName] = useState("");
  const [newMemberId, setNewMemberId] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = "Chat — Meterhouse";
  }, []);

  const channels = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.get<Channel[]>("/chat/channels"),
    refetchInterval: 15_000,
  });

  const assignees = useQuery({
    queryKey: qk.assignees,
    queryFn: () => api.get<Assignee[]>("/pm/assignees"),
  });

  const activeId = selected ?? channels.data?.[0]?.id ?? null;

  const messages = useQuery({
    queryKey: qk.channelMessages(activeId ?? -1),
    queryFn: () => api.get<ChatMessage[]>(`/chat/channels/${activeId}/messages`),
    enabled: activeId !== null,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.data, activeId]);

  // Live messages: append to whichever channel's cache they belong to, and
  // bump that channel's ordering by invalidating the list.
  useEffect(() => {
    return onChatMessage((evt) => {
      qc.setQueryData<ChatMessage[]>(qk.channelMessages(evt.channel_id), (prev) =>
        prev ? [...prev, evt.message as ChatMessage] : prev,
      );
      qc.invalidateQueries({ queryKey: qk.channels });
    });
  }, [onChatMessage, qc]);

  const send = useMutation({
    mutationFn: async () => {
      if (!activeId) return;
      const body = draft.trim();
      // Prefer the live socket; REST is the fallback when it's not connected.
      if (!sendChat(activeId, body)) {
        const message = await api.post<ChatMessage>(`/chat/channels/${activeId}/messages`, { body });
        qc.setQueryData<ChatMessage[]>(qk.channelMessages(activeId), (prev) =>
          prev ? [...prev, message] : prev,
        );
        qc.invalidateQueries({ queryKey: qk.channels });
      }
    },
    onSuccess: () => setDraft(""),
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const createChannel = useMutation({
    mutationFn: () => api.post<Channel>("/chat/channels", { name: newChannelName.trim(), member_ids: [] }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: qk.channels });
      setSelected(c.id);
      setCreating(null);
      setNewChannelName("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const startDm = useMutation({
    mutationFn: () => api.post<Channel>("/chat/dm", { user_id: Number(newMemberId) }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: qk.channels });
      setSelected(c.id);
      setCreating(null);
      setNewMemberId("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const active = channels.data?.find((c) => c.id === activeId);
  const channelList = channels.data?.filter((c) => c.kind === "channel") ?? [];
  const dmList = channels.data?.filter((c) => c.kind === "dm") ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <Card className="flex flex-col gap-4 p-3">
          <div>
            <div className="mb-1.5 flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-ink-2">Channels</span>
              <Button size="sm" variant="subtle" onClick={() => setCreating("channel")}>
                +
              </Button>
            </div>
            <div className="flex flex-col gap-0.5">
              {channelList.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm ${
                    c.id === activeId ? "bg-surface-2 font-semibold" : "text-ink-2 hover:bg-surface-2"
                  }`}
                >
                  <Hash className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{c.name || "Untitled"}</span>
                </button>
              ))}
              {channelList.length === 0 && <p className="px-2 text-xs text-muted">No channels yet.</p>}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-ink-2">Direct messages</span>
              <Button size="sm" variant="subtle" onClick={() => setCreating("dm")}>
                +
              </Button>
            </div>
            <div className="flex flex-col gap-0.5">
              {dmList.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm ${
                    c.id === activeId ? "bg-surface-2 font-semibold" : "text-ink-2 hover:bg-surface-2"
                  }`}
                >
                  <UserIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{channelLabel(c, user?.id, assignees.data)}</span>
                </button>
              ))}
              {dmList.length === 0 && <p className="px-2 text-xs text-muted">No conversations yet.</p>}
            </div>
          </div>
        </Card>

        <Card className="flex h-[32rem] flex-col p-0">
          {!active ? (
            <EmptyState
              title="No conversation selected"
              hint="Create a channel or start a direct message to get going."
            />
          ) : (
            <>
              <div className="border-b border-line px-4 py-3">
                <h3 className="font-semibold">{channelLabel(active, user?.id, assignees.data)}</h3>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-3">
                {messages.isLoading ? (
                  <LoadingState />
                ) : (messages.data?.length ?? 0) === 0 ? (
                  <EmptyState title="No messages yet" hint="Say hello." />
                ) : (
                  <div className="flex flex-col gap-3">
                    {messages.data!.map((m) => (
                      <div key={m.id} className={m.author_user_id === user?.id ? "text-right" : ""}>
                        <div className="text-xs text-muted">
                          {m.author_email} · {fmtRelative(m.created_at)}
                        </div>
                        <div
                          className={`mt-0.5 inline-block max-w-[80%] rounded-lg px-3 py-2 text-left text-sm ${
                            m.author_user_id === user?.id ? "bg-accent text-white" : "bg-surface-2"
                          }`}
                        >
                          {m.body}
                        </div>
                      </div>
                    ))}
                    <div ref={bottomRef} />
                  </div>
                )}
              </div>

              <div className="flex gap-2 border-t border-line p-3">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (draft.trim()) send.mutate();
                    }
                  }}
                  placeholder="Write a message… (Enter to send)"
                  rows={1}
                  className="flex-1"
                />
                <Button disabled={!draft.trim()} loading={send.isPending} onClick={() => send.mutate()}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>

      <Modal open={creating === "channel"} onClose={() => setCreating(null)} title="New channel">
        <div className="flex flex-col gap-3">
          <Field label="Channel name" required>
            {(p) => (
              <Input
                {...p}
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                placeholder="e.g. engineering"
                autoFocus
              />
            )}
          </Field>
          <div className="flex justify-end">
            <Button
              disabled={!newChannelName.trim()}
              loading={createChannel.isPending}
              onClick={() => createChannel.mutate()}
            >
              Create channel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={creating === "dm"} onClose={() => setCreating(null)} title="New direct message">
        <div className="flex flex-col gap-3">
          <Field label="Teammate">
            {(p) => (
              <Select {...p} value={newMemberId} onChange={(e) => setNewMemberId(e.target.value)}>
                <option value="">Select someone…</option>
                {assignees.data
                  ?.filter((a) => a.id !== user?.id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.full_name || a.email}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <div className="flex justify-end">
            <Button disabled={!newMemberId} loading={startDm.isPending} onClick={() => startDm.mutate()}>
              Start conversation
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
