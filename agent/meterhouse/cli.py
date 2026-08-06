"""Meterhouse agent CLI (local mode).

    python -m meterhouse scan       # ingest new/changed transcripts
    python -m meterhouse today      # today's usage by model
    python -m meterhouse week       # last 7 days
    python -m meterhouse stats      # all-time statistics
    python -m meterhouse identity   # show this machine's system_id

Local mode needs no central server. Central-mode commands (register/sync/
heartbeat) push usage to a central dashboard; see `--help` for each.

`install-hooks` is the normal way to run the agent in the background: it wires
Claude Code's session hooks so the daemon starts with a session and exits when
the last one ends, leaving no process behind on an idle machine.

`daemon` is what those hooks launch: it scans on a timer (default 60s,
configurable via runtime.json or METERHOUSE_* env vars) for as long as a
session is open, and if configured holds a WebSocket open for real-time status
push. `sessions` shows what it thinks is live; `health` reports its last-known
state.
"""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime, timezone

from . import __version__
from .account import collect_account_report
from .config import AgentConfig
from .identity import load_identity, save_identity
from .pricing import calc_cost, fmt_cost, fmt_tokens
from .reports import all_time_stats, cost_of, last_n_days, totals_for_day
from .scanner import scan as run_scan
from .store import Store, default_db_path


def _hr(char="-", width=64):
    print(char * width)


def _row_cost(r) -> float:
    """Estimated cost for one by-model row. Shared by `today` and `stats`,
    which otherwise print different columns."""
    return calc_cost(r["model"], r["inp"] or 0, r["out"] or 0, r["cr"] or 0, r["cc"] or 0)


def _active_session_count() -> int:
    """Claude Code sessions live on this machine right now."""
    from .sessions import SessionRegistry

    try:
        cfg = AgentConfig.load().validated()
        return len(SessionRegistry().active(cfg.session_idle_timeout_seconds))
    except Exception:  # noqa: BLE001 - a status field is never worth an error
        return 0


def _status(ident, state, detail="", **extra):
    """Best-effort status ping for the dashboard's live agent view.

    Central mode only, and every failure is swallowed — the scan or sync this
    annotates has to work the same on a machine that cannot reach the server.

    `active_sessions` rides along by default. Without it a one-shot run would
    leave whatever the daemon last wrote, so a machine could sit at
    "1 active session" indefinitely after that session ended.
    """
    if not (ident.server_url and ident.api_key):
        return
    from .sync import SyncClient

    extra.setdefault("active_sessions", _active_session_count())
    try:
        SyncClient(ident.server_url, ident.api_key).report_status(state, detail, **extra)
    except Exception:  # noqa: BLE001
        pass


def _report_finished(ident, detail=""):
    """The last status a one-shot run leaves behind.

    This is the whole reason an idle machine reads correctly. `scan`, `sync`
    and `once` used to end on "idle" — a mid-cycle state that means "working,
    between scans". On the machines these commands actually run on (the daily
    catch-up task, on a PC where nobody opened Claude Code) that state then sat
    there ageing, and the dashboard graded the silence that followed as stalled
    and then dead. Reporting the terminal state instead is what marks the
    machine dormant.

    When a session *is* live the daemon owns the status line, so this reports
    "idle" and leaves the next-scan countdown intact rather than claiming the
    agent stopped underneath it.
    """
    sessions = _active_session_count()
    if sessions:
        _status(ident, "idle", detail or "agent running", active_sessions=sessions)
    else:
        _status(ident, "stopped", "no active Claude Code sessions", active_sessions=0)


def cmd_scan(args, report_finished: bool = True):
    """One-shot scan.

    `report_finished` is False when `once` runs this, because the sync that
    immediately follows reports the terminal state for the pair — otherwise the
    dashboard would see the machine stop and then start syncing again.
    """
    ident = load_identity(display_name=args.display_name)
    started = datetime.now(timezone.utc)
    _status(ident, "scanning", "one-shot scan")
    summary = run_scan(system_id=ident.system_id, db_path=args.db,
                       verbose=not args.quiet)
    duration_ms = (datetime.now(timezone.utc) - started).total_seconds() * 1000
    _status(
        ident,
        "scanned",
        f"{summary.get('events_inserted', 0)} new events",
        last_scan_at=started.isoformat(),
        last_scan_duration_ms=round(duration_ms, 1),
    )
    if report_finished:
        _report_finished(ident, f"{summary.get('events_inserted', 0)} new events")
    if args.quiet:
        print(summary)


def cmd_today(args):
    ident = load_identity()
    store = Store(args.db or default_db_path())
    try:
        today = date.today().isoformat()
        data = totals_for_day(store, today)
        print()
        _hr()
        print(f"  Today's tracked usage  ({today})   [{ident.display_name}]")
        _hr()
        if not data["by_model"]:
            print("  No usage recorded today.\n")
            return
        ti = to = 0
        tc = 0.0
        for r in data["by_model"]:
            c = _row_cost(r)
            tc += c
            ti += r["inp"] or 0
            to += r["out"] or 0
            print(f"  {r['model']:<28} events={r['events']:<4} "
                  f"in={fmt_tokens(r['inp']):<8} out={fmt_tokens(r['out']):<8} "
                  f"est={fmt_cost(c)}")
        _hr()
        print(f"  {'TOTAL':<28} in={fmt_tokens(ti):<8} out={fmt_tokens(to):<8} "
              f"est={fmt_cost(tc)}")
        print(f"  Sessions today: {data['sessions']}")
        _hr()
        print("  (estimate only - not official Max/Pro quota)\n")
    finally:
        store.close()


def cmd_week(args):
    store = Store(args.db or default_db_path())
    try:
        rows = last_n_days(store, 7)
        print()
        _hr()
        print("  Last 7 days (tracked tokens)")
        _hr()
        if not rows:
            print("  No usage in the last 7 days.\n")
            return
        for r in rows:
            print(f"  {r['day']}  tokens={fmt_tokens(r['tokens']):<9} "
                  f"events={r['events']}")
        _hr()
        print()
    finally:
        store.close()


def cmd_stats(args):
    store = Store(args.db or default_db_path())
    try:
        s = all_time_stats(store)
        t = s["totals"]
        print()
        _hr("=")
        print("  Meterhouse - all-time tracked usage")
        _hr("=")
        print(f"  Sessions:       {t['sessions'] or 0:,}")
        print(f"  Events:         {fmt_tokens(t['events'] or 0)}")
        print(f"  Input tokens:   {fmt_tokens(t['inp'] or 0)}")
        print(f"  Output tokens:  {fmt_tokens(t['out'] or 0)}")
        print(f"  Cache read:     {fmt_tokens(t['cr'] or 0)}")
        print(f"  Cache creation: {fmt_tokens(t['cc'] or 0)}")
        print(f"  Est. cost:      {fmt_cost(cost_of(s['by_model']))}")
        _hr()
        print("  By model:")
        for r in s["by_model"]:
            c = _row_cost(r)
            print(f"    {r['model']:<28} sessions={r['sessions']:<4} "
                  f"events={fmt_tokens(r['events']):<7} est={fmt_cost(c)}")
        _hr()
        print("  Top projects:")
        for r in s["top_projects"]:
            print(f"    {r['project']:<40} sessions={r['sessions']:<3} "
                  f"tokens={fmt_tokens(r['tokens'])}")
        _hr("=")
        print("  (estimate only - not official Max/Pro quota)\n")
    finally:
        store.close()


def _unquote(value):
    """Strip one layer of matching surrounding quotes.

    The setup block the dashboard generates is quoted for PowerShell. Pasted
    into cmd.exe — which does not treat `'...'` as quoting — the quotes arrive
    as part of the value, so the agent would store `'https://host'` as the
    server URL and every request would fail with a confusing error far from the
    cause. Neither a URL nor an API key can legitimately start and end with a
    quote, so removing one matched pair is always safe.
    """
    if value is None:
        return None
    v = value.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        return v[1:-1].strip()
    return v


def cmd_register(args):
    from .config import AgentConfig
    from .sync import SyncClient, SyncError, warn_if_insecure

    server = _unquote(args.server)
    api_key = _unquote(args.api_key)
    args.display_name = _unquote(args.display_name)
    args.ws_url = _unquote(args.ws_url)

    if not server.lower().startswith(("http://", "https://")):
        print(f"Invalid --server value: {server!r}\n"
              "It must be the dashboard URL, e.g. https://meterhouse.netlify.app")
        return

    ident = load_identity(display_name=args.display_name)
    ident.server_url = server.rstrip("/")
    ident.api_key = api_key

    warning = warn_if_insecure(ident.server_url)
    if warning:
        print(warning)
    if args.display_name:
        ident.display_name = args.display_name
    save_identity(ident)

    if args.ws_url:
        ws_warning = warn_if_insecure(args.ws_url)
        if ws_warning:
            print(ws_warning)
        cfg = AgentConfig.load()
        cfg.ws_enabled = True
        cfg.ws_url = args.ws_url
        cfg.save()
        print(f"Real-time push configured: {args.ws_url}")

    try:
        resp = SyncClient(ident.server_url, ident.api_key).register(
            ident.display_name, ident.hostname, ident.agent_version)
        print(f"Registered with central server as '{resp['display_name']}' "
              f"(server system_id {resp['system_id']}).")
    except SyncError as e:
        print(f"Saved config, but registration call failed: {e}")


def cmd_heartbeat(args):
    from .sync import SyncClient, SyncError
    ident = load_identity()
    if not ident.server_url or not ident.api_key:
        print("Central mode not configured. Run: meterhouse register ...")
        return
    try:
        SyncClient(ident.server_url, ident.api_key).heartbeat()
        print("Heartbeat sent.")
    except SyncError as e:
        print(f"Heartbeat failed (offline?): {e}")


def _report_account(client, cfg, verbose=True):
    """Push the Claude account report, if the operator turned it on.

    Previously only the daemon did this, so anyone driving the agent by hand
    (`scan` + `sync`) enabled account reporting, was told it was ENABLED, and
    then saw the dashboard's Claude accounts page stay permanently empty —
    with nothing to explain the gap. Reporting on sync closes that.

    Optional extra: every failure is swallowed. A usage push must never be
    reported as failed because this part didn't work.
    """
    if not cfg.account_reporting_enabled:
        return
    from .account import collect_account_report
    from .sync import SyncError

    try:
        payload = collect_account_report(enabled=True)
        if payload is None:
            if verbose:
                print("Account reporting is on, but no Claude account was found "
                      "in ~/.claude.json - nothing to report.")
            return
        client.report_account(payload)
        if verbose:
            print("Claude account details reported.")
    except SyncError as e:
        if verbose:
            print(f"Account report failed (usage sync was unaffected): {e}")
    except Exception as e:  # noqa: BLE001 - never let this fail a usage sync
        if verbose:
            print(f"Account report skipped: {type(e).__name__}: {e}")


def _run_pending_commands(client, commands, system_id, db_path=None, verbose=True):
    """Execute commands the server handed back, then ack each one.

    Without this, the dashboard's agent controls only worked for machines
    running `meterhouse daemon`. The recommended background setup is a
    scheduled `scan` + `sync`, and under it a queued command was marked
    delivered and then sat pending forever — the button appeared to work and
    nothing happened.

    `pause`/`resume` govern a running scan loop, so there is nothing to pause
    here; they are acked as skipped rather than silently swallowed, which keeps
    the dashboard honest about what actually took effect.
    """
    from .config import AgentConfig
    from .scanner import scan as run_scan
    from .sync import SyncError

    for command in commands or []:
        command_id = command.get("id")
        action = command.get("action")
        payload = command.get("payload") or {}
        status, detail = "acked", ""

        try:
            if action == "scan_now":
                summary = run_scan(system_id=system_id, db_path=db_path, verbose=False)
                detail = f"scanned {summary.get('events_inserted', 0)} new events"
            elif action == "set_config":
                # Same allowlist and clamping the daemon applies. This path
                # previously accepted any attribute that happened to exist and
                # saved it unvalidated, so one dashboard action reached further
                # here than it did there.
                applied = AgentConfig.load().apply_patch(payload)
                detail = f"applied: {', '.join(applied)}" if applied else "no recognized fields"
            elif action in ("pause", "resume"):
                status, detail = "skipped", f"{action} needs the daemon; this is a one-shot sync"
            else:
                status, detail = "failed", f"unknown action '{action}'"
        except Exception as exc:  # noqa: BLE001 - report it, never fail the sync
            status, detail = "failed", f"{type(exc).__name__}: {exc}"

        if verbose:
            print(f"Command {action}: {status} ({detail})")
        if command_id is not None:
            try:
                client.ack_command(command_id, status, detail)
            except SyncError as exc:
                if verbose:
                    print(f"Could not ack command {command_id}: {exc}")


def cmd_sync(args):
    from .sync import SyncClient, SyncError, sync_store
    ident = load_identity()
    if not ident.server_url or not ident.api_key:
        print("Central mode not configured. Run: meterhouse register "
              "--server URL --api-key KEY")
        return
    store = Store(args.db or default_db_path())
    cfg = AgentConfig.load()
    try:
        client = SyncClient(ident.server_url, ident.api_key)
        _status(ident, "syncing", "pushing usage to the dashboard")
        totals = sync_store(store, client, verbose=not args.quiet,
                            send_titles=cfg.session_titles_enabled)
        print(f"Sync complete: inserted={totals['inserted']} "
              f"duplicates={totals['duplicates']} (sent={totals['received']}).")
        _report_account(client, cfg, verbose=not args.quiet)

        # Always check in, even when there was nothing to push. Two reasons:
        # `sync_store` sends no request at all on an idle machine, so without
        # this the dashboard sees no contact and reports the agent as dead when
        # it is simply quiet; and this is where queued commands are collected,
        # which is what makes the dashboard's controls work for machines that
        # run the scheduled scan+sync rather than the daemon.
        resp = client.heartbeat()
        _run_pending_commands(
            client,
            resp.get("commands", []),
            system_id=ident.system_id,
            db_path=args.db,
            verbose=not args.quiet,
        )
        _report_finished(ident, f"synced {totals['inserted']} events")
    except SyncError as e:
        print(f"Sync failed (offline?) - will retry next run: {e}")
        _status(ident, "error", str(e))
    finally:
        store.close()


def cmd_once(args):
    """One full cycle: scan, then sync (which also collects queued commands).

    This is what the daily catch-up task runs. It exists as a single
    subcommand rather than `scan && sync` because the chaining form has to be
    wrapped in `cmd /c` inside a scheduled task's action string, and the nested
    quoting there is a reliable source of tasks that register but never run —
    which left machines silently not reporting.
    """
    cmd_scan(args, report_finished=False)
    cmd_sync(args)


def cmd_daemon(args):
    from .daemon import run_daemon
    run_daemon(display_name=args.display_name, db_path=args.db,
               always_on=True if args.always_on else None)


def cmd_hook(args):
    """Run a Claude Code hook handler. Never prints, never fails.

    Not intended to be run by hand — `install-hooks` wires it into
    `~/.claude/settings.json`, and Claude Code invokes it with the event
    payload on stdin.
    """
    from .hooks import run
    raise SystemExit(run(args.event))


def cmd_install_hooks(args):
    from .hookinstall import install
    ok, message = install()
    print(message)
    if ok:
        print("The agent will now start with your next Claude Code session "
              "and stop when it ends.")
    else:
        raise SystemExit(1)


def cmd_uninstall_hooks(args):
    from .hookinstall import uninstall
    ok, message = uninstall()
    print(message)
    if not ok:
        raise SystemExit(1)


def cmd_sessions(args):
    """Show the Claude Code sessions this machine believes are live.

    The first thing to check when the agent is running and shouldn't be, or
    isn't running and should: it is the sole input to that decision.
    """
    from .hooks import daemon_is_running
    from .hookinstall import status as hook_status
    from .sessions import SessionRegistry

    cfg = AgentConfig.load().validated()
    registry = SessionRegistry()
    live = registry.active(cfg.session_idle_timeout_seconds)

    print()
    _hr()
    print("  Claude Code sessions")
    _hr()
    if not live:
        print("  None active. The agent is not expected to be running.")
    for record in live:
        idle = int(record.age_seconds())
        print(f"  {record.session_id}")
        print(f"    started {record.started_at}  idle {idle}s")
        if record.cwd:
            print(f"    cwd     {record.cwd}")
    _hr()
    hooks = hook_status()
    missing = [event for event, present in hooks["events"].items() if not present]
    if hooks["error"]:
        print(f"  Hooks:  could not be read - {hooks['error']}")
    elif missing:
        print(f"  Hooks:  NOT installed ({', '.join(missing)}) - run "
              f"`meterhouse install-hooks`")
    else:
        print(f"  Hooks:  installed in {hooks['path']}")
    print(f"  Daemon: {'running' if daemon_is_running() else 'not running'}")
    print(f"  Idle timeout: {cfg.session_idle_timeout_seconds}s")
    _hr()
    print()


def cmd_health(args):
    from .health import HealthState
    state = HealthState.load()
    if state is None:
        print("No daemon health data yet. The agent runs only during a Claude Code "
              "session — run `meterhouse install-hooks`, then start one.")
        return
    print()
    _hr()
    print("  Meterhouse daemon health")
    _hr()
    print(f"  PID:                 {state.pid}")
    print(f"  Started:             {state.started_at}")
    print(f"  Last update:         {state.updated_at}")
    print(f"  Active sessions:     {state.active_sessions}")
    if state.stopped_at:
        print(f"  Stopped cleanly at:  {state.stopped_at}")
    print(f"  Scans completed:     {state.scans_completed}")
    print(f"  Scans failed:        {state.scans_failed}")
    print(f"  Last scan:           {state.last_scan_at or 'never'}")
    if state.last_scan_duration_ms is not None:
        print(f"  Last scan duration:  {state.last_scan_duration_ms:.1f} ms")
    if state.last_scan_error:
        print(f"  Last scan error:     {state.last_scan_error}")
    print(f"  WebSocket connected: {state.ws_connected}")
    if state.ws_last_disconnect_reason:
        print(f"  Last disconnect:     {state.ws_last_disconnect_reason}")
    print(f"  Reconnect attempts:  {state.ws_reconnect_attempts}")
    print(f"  Offline queue depth: {state.offline_queue_depth}")
    _hr()
    print()


def cmd_identity(args):
    ident = load_identity(display_name=args.display_name)
    if args.set_display_name:
        ident.display_name = args.set_display_name
        save_identity(ident)
    print()
    for k, v in ident.public_dict().items():
        print(f"  {k:<16} {v}")
    print()


def cmd_account(args):
    """Inspect or toggle Claude account reporting.

    `show` exists so nobody has to take the privacy claim on trust: it prints
    the exact payload that would be transmitted, without transmitting it.
    """
    cfg = AgentConfig.load()

    if args.action in ("enable", "disable"):
        cfg.account_reporting_enabled = args.action == "enable"
        cfg.save()
        state = "ENABLED" if cfg.account_reporting_enabled else "DISABLED"
        print(f"\n  Claude account reporting is now {state}.\n")
        if not cfg.account_reporting_enabled:
            return
        print("  Run `meterhouse account show` to see exactly what will be sent.")
        # Enabling alone changes nothing on the dashboard until a report is
        # actually pushed, which is easy to miss — say so explicitly.
        print("  It is sent on the next `meterhouse sync` (or by the daemon).\n")
        return

    # show — read with reporting forced on, so the payload is visible even
    # while the feature is switched off.
    report = collect_account_report(enabled=True)
    print()
    if cfg.account_reporting_enabled:
        print("  Reporting is ENABLED - the payload below is sent on each scan.")
    else:
        print("  Reporting is DISABLED - nothing is sent. Preview only.")
    _hr()
    if report is None:
        print("  No Claude account found in ~/.claude.json.")
        print("  (Sign in to Claude Code, or set METERHOUSE_CLAUDE_JSON.)")
    else:
        print(json.dumps(report, indent=2))
    _hr()
    print("  Credentials and OAuth tokens are never read. See meterhouse/account.py.")
    print()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="meterhouse",
                                description="Meterhouse local usage agent")
    p.add_argument("--version", action="version", version=__version__)
    p.add_argument("--db", default=None, help="override local DB path")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("scan", help="ingest new/changed transcripts")
    s.add_argument("--display-name", default=None,
                   help="set machine label on first run (e.g. PC-01)")
    s.add_argument("--quiet", action="store_true")
    s.set_defaults(func=cmd_scan)

    sub.add_parser("today", help="today's usage").set_defaults(func=cmd_today)
    sub.add_parser("week", help="last 7 days").set_defaults(func=cmd_week)
    sub.add_parser("stats", help="all-time stats").set_defaults(func=cmd_stats)

    # central mode
    rg = sub.add_parser("register", help="configure + register with a central server")
    rg.add_argument("--server", required=True, help="central API base URL")
    rg.add_argument("--api-key", required=True, help="agent API key (from admin)")
    rg.add_argument("--display-name", default=None)
    rg.add_argument("--ws-url", default=None,
                    help="enable real-time push over this WebSocket URL (optional)")
    rg.set_defaults(func=cmd_register)

    sub.add_parser("heartbeat", help="send a liveness heartbeat").set_defaults(func=cmd_heartbeat)

    sy = sub.add_parser("sync", help="push unsynced usage to the central server")
    sy.add_argument("--quiet", action="store_true")
    sy.set_defaults(func=cmd_sync)

    on = sub.add_parser(
        "once",
        help="one cycle: scan + sync + run any commands queued by the dashboard",
    )
    on.add_argument("--display-name", default=None)
    on.add_argument("--quiet", action="store_true")
    on.set_defaults(func=cmd_once)

    ac = sub.add_parser(
        "account",
        help="inspect or toggle Claude account reporting (off by default)",
    )
    ac.add_argument(
        "action",
        nargs="?",
        default="show",
        choices=["show", "enable", "disable"],
        help="show the exact payload that would be sent, or turn reporting on/off",
    )
    ac.set_defaults(func=cmd_account)

    idp = sub.add_parser("identity", help="show/update this machine's identity")
    idp.add_argument("--display-name", default=None)
    idp.add_argument("--set-display-name", default=None)
    idp.set_defaults(func=cmd_identity)

    dm = sub.add_parser(
        "daemon",
        help="scan while a Claude Code session is open, then exit "
             "(config: runtime.json) + optional real-time push",
    )
    dm.add_argument("--display-name", default=None)
    dm.add_argument(
        "--always-on",
        action="store_true",
        help="never exit when sessions end (for machines that cannot use hooks)",
    )
    dm.set_defaults(func=cmd_daemon)

    hk = sub.add_parser("hook", help="internal: Claude Code hook handler")
    hk.add_argument("event", choices=["session-start", "session-end", "keepalive"])
    hk.set_defaults(func=cmd_hook)

    sub.add_parser(
        "install-hooks",
        help="start/stop the agent automatically with your Claude Code sessions",
    ).set_defaults(func=cmd_install_hooks)
    sub.add_parser(
        "uninstall-hooks", help="remove the Claude Code hooks this agent installed"
    ).set_defaults(func=cmd_uninstall_hooks)
    sub.add_parser(
        "sessions", help="show live Claude Code sessions, hook and daemon state"
    ).set_defaults(func=cmd_sessions)

    sub.add_parser("health", help="show the daemon's last-known status").set_defaults(
        func=cmd_health
    )
    return p


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
