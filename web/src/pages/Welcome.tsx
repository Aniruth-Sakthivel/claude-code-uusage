/**
 * First-run onboarding.
 *
 * Where a new admin lands after creating their account. Previously this step
 * was bolted onto the sign-in screen, so it reappeared on every login and was
 * never clearly "setup".
 */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { SystemRow } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ConnectPanel } from "../components/ConnectPanel";
import { Button, Card, Eyebrow } from "../components/ui";

export function Welcome() {
  const { user, can } = useAuth();

  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });

  useEffect(() => {
    document.title = "Get started — Meterhouse";
  }, []);

  const hasSystems = (systems.data?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Eyebrow>Getting started</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Welcome{user?.full_name ? `, ${user.full_name.split(" ")[0]}` : ""}
        </h1>
        <p className="mt-1.5 max-w-2xl text-base text-muted">
          Meterhouse reads the transcript files Claude Code already writes on each PC and
          reports how many tokens each machine uses. Connect your first PC below — name
          it, then paste one line into PowerShell on that machine. Nothing runs in the
          background until you actually use Claude Code.
        </p>
      </div>

      <ConnectPanel systems={systems.data ?? []} />

      {hasSystems && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-base font-medium">
              {systems.data!.length} PC{systems.data!.length === 1 ? "" : "s"} connected
            </div>
            <div className="text-sm text-muted">
              Usage appears on the dashboard after the first sync.
            </div>
          </div>
          <Link to="/dashboard">
            <Button>Go to dashboard</Button>
          </Link>
        </Card>
      )}

      {can("manage_users") && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-base font-medium">Working with a team?</div>
            <div className="text-sm text-muted">
              Invite people by email and choose which machines each of them can see.
            </div>
          </div>
          <Link to="/admin/users">
            <Button variant="ghost">Invite teammates</Button>
          </Link>
        </Card>
      )}
    </div>
  );
}
