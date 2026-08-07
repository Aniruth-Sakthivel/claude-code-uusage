"""Meterhouse agent CLI (local mode).

    python -m meterhouse scan       # ingest new/changed transcripts
    python -m meterhouse today      # today's usage by model
    python -m meterhouse week       # last 7 days
    python -m meterhouse stats      # all-time statistics
    python -m meterhouse identity   # show this machine's system_id

Local mode needs no central server. Central-mode commands (register/sync/
heartbeat) push usage to a central dashboard; see `--help` for each.

`daemon` is the agent's normal running state: it scans continuously (default
every 5s, configurable via runtime.json, METERHOUSE_* env vars, or a remote
`set_config` command), independent of whether Claude Code is open, and if
configured holds a WebSocket open for real-time status push. It is launched
once — by `install.ps1`, or by hand — and kept alive by an OS-level scheduled
task that repeatedly (and harmlessly, if one is already running) tries to
start one; see `deploy/install.ps1`.

`status` shows whether a daemon is currently running and its last-known
state; `stop` ends a running daemon (the scheduled task relaunches it within
about a minute, unless you also remove that task); `health` reports the
daemon's full diagnostics snapshot.

`connect` is every setup step collapsed into one command: register with the
central server, do an initial scan + sync, start the daemon, and (on
Windows) register the scheduled task that keeps it running across reboots.
It's what `deploy/install.ps1` and the dashboard's "Connect a PC" flow both
do under the hood, exposed directly for anyone installing the package by
hand.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import date, datetime, timezone

from . import __version__

log = logging.getLogger(__name__)
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
    """Claude Code sessions live on this machine right now, approximated from
    recent transcript activity — see `activity.count_recent`."""
    from .activity import ActivityWatcher, count_recent

    try:
        cfg = AgentConfig.load().validated()
        return count_recent(ActivityWatcher().snapshot(), cfg.session_idle_timeout_seconds)
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

        # The server's system_id is authoritative — it is resolved from the
        # API key, never from anything the client sends, and it is what every
        # table in the dashboard is actually keyed on. Without this, the
        # locally-generated id from `load_identity`'s first run (a plain
        # uuid4, unrelated to the server's row) stayed in agent.json forever:
        # every command still worked, because auth is by API key and the
        # server never trusts a client-supplied id, but `meterhouse identity`
        # showed a system_id that existed nowhere in the database — worthless
        # for anyone trying to look this machine up by it.
        if resp.get("system_id") and resp["system_id"] != ident.system_id:
            ident.system_id = resp["system_id"]
        if resp.get("display_name"):
            ident.display_name = resp["display_name"]
        save_identity(ident)
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


def _report_account(client, cfg, verbose=True, force=False):
    """Push the Claude account report, if the operator turned it on.

    Previously only the daemon did this, so anyone driving the agent by hand
    (`scan` + `sync`) enabled account reporting, was told it was ENABLED, and
    then saw the dashboard's Claude accounts page stay permanently empty —
    with nothing to explain the gap. Reporting on sync closes that.

    `force` bypasses the enabled check for one call — used by the
    `refresh_data` command, which explicitly asks for a fresh account read
    regardless of the normal opt-in/cadence.

    Optional extra: every failure is swallowed. A usage push must never be
    reported as failed because this part didn't work.
    """
    if not (cfg.account_reporting_enabled or force):
        return
    from .account import collect_account_report
    from .sync import SyncError

    try:
        payload = collect_account_report(enabled=True)
        from .watcher import validate_account_report
        for issue in validate_account_report(payload):
            if verbose:
                print(f"Account report validation issue: {issue}")
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
    from .sync import SyncError, sync_store

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
            elif action in ("pause", "resume", "stop", "restart"):
                # These all govern a running daemon loop or process this
                # one-shot run does not have — nothing to pause/stop/restart.
                status, detail = "skipped", f"{action} needs a running daemon; this is a one-shot run"
            elif action == "force_sync":
                store = Store(db_path or default_db_path())
                try:
                    totals = sync_store(store, client, verbose=False)
                finally:
                    store.close()
                detail = f"synced {totals['inserted']} new / {totals['duplicates']} dup"
            elif action == "refresh_data":
                summary = run_scan(system_id=system_id, db_path=db_path, verbose=False)
                cfg = AgentConfig.load()
                _report_account(client, cfg, verbose=False, force=True)
                detail = f"scanned {summary.get('events_inserted', 0)} new events, account refresh forced"
            elif action == "health_check":
                from .health import HealthState

                state = HealthState.load()
                if state is None:
                    status, detail = "skipped", "no daemon health state on this machine"
                else:
                    from dataclasses import asdict
                    client.report_health(asdict(state))
                    detail = "health snapshot sent"
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
    run_daemon(display_name=args.display_name, db_path=args.db)


def cmd_status(args):
    """Whether a daemon is currently running, and what it last reported.

    The first thing to check when the agent should be working and isn't, or
    is running and shouldn't be.
    """
    from .activity import ActivityWatcher, count_recent
    from .lockfile import is_daemon_running, read_locked_pid

    cfg = AgentConfig.load().validated()
    running = is_daemon_running()
    active = count_recent(ActivityWatcher().snapshot(), cfg.session_idle_timeout_seconds)

    print()
    _hr()
    print("  Meterhouse agent status")
    _hr()
    if running:
        pid = read_locked_pid()
        print(f"  Daemon:  running{f' (pid {pid})' if pid else ''}")
    else:
        print("  Daemon:  not running")
        print("           the scheduled task supervisor should relaunch it "
              "within about a minute")
    print(f"  Active transcripts (last {cfg.session_idle_timeout_seconds}s): {active}")
    print(f"  Scan interval: {cfg.scan_interval_seconds}s   "
          f"Sync interval: {cfg.sync_interval_seconds}s")
    _hr()
    print()


def cmd_stop(args):
    """Stop a locally running daemon by PID.

    Distinct from the dashboard's remote `stop` Trigger command, which only
    reaches a daemon already talking to the server — this works offline, and
    is what local troubleshooting/uninstall needs, since a detached
    background process has no attached terminal to interrupt.
    """
    import subprocess

    from .lockfile import is_daemon_running, read_locked_pid

    if not is_daemon_running():
        print("No daemon is running.")
        return

    pid = read_locked_pid()
    if pid is None:
        print("A daemon is running, but its PID could not be read from the lock file.")
        raise SystemExit(1)

    if os.name == "nt":
        result = subprocess.run(
            ["taskkill", "/PID", str(pid), "/F"], capture_output=True, text=True
        )
        ok = result.returncode == 0
    else:
        import signal as signal_module

        try:
            os.kill(pid, signal_module.SIGTERM)
            ok = True
        except OSError as exc:
            print(f"Could not stop pid {pid}: {exc}")
            ok = False

    if ok:
        print(f"Stopped daemon (pid {pid}). The scheduled task will relaunch it "
              "within about a minute, unless it has been removed.")
    else:
        raise SystemExit(1)


def _register_supervisor_task() -> None:
    """Register the Scheduled Task that relaunches the daemon if it dies.

    Windows only — Task Scheduler is what makes a fire-and-forget relaunch
    trigger safe (`run_daemon`'s single-instance lock turns every redundant
    firing into a no-op), and there's no cross-platform equivalent to reach
    for here. Mirrors `REGISTER_SUPERVISOR_COMMAND` in
    `web/src/lib/agentSetup.ts` and the task `deploy/install.ps1` registers —
    kept in sync by hand, since those are PowerShell text for a browser to
    display and this is PowerShell actually executed here.

    Deliberately no `-RepetitionDuration`: leaving it unset is what makes the
    repeat indefinite. `[TimeSpan]::MaxValue` used to be passed there to mean
    "forever" — it looks right, but Task Scheduler serializes triggers as an
    ISO 8601 duration and MaxValue overflows what that format can represent.
    `Register-ScheduledTask` did not error on it; the task simply failed
    every time it tried to *run*, with "The task XML contains a value which
    is incorrectly formatted or out of range" — silent at registration time,
    which is exactly what made it easy to ship. The `Get-ScheduledTask`
    verification below exists so a definition Task Scheduler will actually
    reject shows up here as a failure, not as a task that "registered fine"
    and then quietly never restarted anything.
    """
    import subprocess

    from .daemon import daemon_command

    command = daemon_command()
    if not command:
        print("Could not determine how to relaunch the daemon; skipping scheduled task.")
        return

    exe, rest = command[0], command[1:]
    script = (
        f"$act = New-ScheduledTaskAction -Execute '{exe}' -Argument '{' '.join(rest)}'; "
        "$logon = New-ScheduledTaskTrigger -AtLogOn; "
        "$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) "
        "-RepetitionInterval (New-TimeSpan -Minutes 1); "
        # Elevated -> a real SYSTEM principal, so the task runs machine-wide
        # with no login required. Not elevated -> no -Principal at all,
        # letting Register-ScheduledTask default to this process's own token
        # — passing an explicit Principal (even asking for no more than that
        # token already has) routes registration through a code path that
        # needs elevation and fails with "Access is denied" without it.
        "$isElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent())"
        ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); "
        "if ($isElevated) { "
        "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest; "
        "Register-ScheduledTask -TaskName 'Meterhouse Agent' -Action $act "
        "-Trigger @($logon, $repeat) -Principal $principal -Force | Out-Null "
        "} else { "
        "Register-ScheduledTask -TaskName 'Meterhouse Agent' -Action $act "
        "-Trigger @($logon, $repeat) -Force | Out-Null "
        "}; "
        "$t = Get-ScheduledTask -TaskName 'Meterhouse Agent' -ErrorAction Stop; "
        "if ($t.State -eq 'Disabled') { throw 'Task registered but is Disabled' }; "
        "Write-Output \"VERIFIED:$(if ($isElevated) {'machine-wide'} else {'per-user'}):$($t.State)\""
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True,
        )
    except OSError as exc:
        print(f"Could not run PowerShell to register the scheduled task: {exc!r} "
              f"(is powershell.exe on PATH?)")
        return

    log.info(
        "scheduled task registration",
        extra={
            "command": ["powershell", "-Command", script],
            "exit_code": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        },
    )
    if result.returncode == 0 and "VERIFIED:" in result.stdout:
        scope, _, state = result.stdout.strip().rsplit("VERIFIED:", 1)[-1].partition(":")
        print(f"Scheduled task 'Meterhouse Agent' registered and verified "
              f"(scope: {scope}, state: {state}) — the daemon now survives reboots.")
    else:
        # PowerShell surfaces Win32 errors (e.g. "Access is denied") in
        # stderr via the exception's own message; nothing to translate here
        # beyond showing the exit code and the exact text PowerShell gave.
        print(f"Could not register the scheduled task automatically "
              f"(exit code {result.returncode}): {result.stderr.strip() or result.stdout.strip()}")
        print("Retry from an elevated ('Run as Administrator') shell for a machine-wide task, "
              "or see agent/README.md §6 to register one yourself.")


def cmd_connect(args):
    """One command, every setup step: register, scan, sync, start the
    daemon, and (on Windows) register the scheduled task that keeps it
    running across reboots.

    Runs the same steps `deploy/install.ps1` and the dashboard's "Connect a
    PC" block do, in order, so a plain `pip install meterhouse-rotor` +
    `meterhouse connect ...` is a complete, working setup by itself.
    """
    from .daemon import daemon_command, spawn_detached
    from .lockfile import is_daemon_running

    print("\n[1/4] Registering with the central server...")
    cmd_register(argparse.Namespace(
        server=args.server, api_key=args.api_key,
        display_name=args.display_name, ws_url=args.ws_url,
    ))

    if args.account:
        cfg = AgentConfig.load()
        cfg.account_reporting_enabled = True
        cfg.save()
        print("Claude account reporting is now ENABLED.")

    print("\n[2/4] Scanning local transcripts and syncing to the dashboard...")
    cmd_scan(argparse.Namespace(display_name=args.display_name, db=args.db,
                                 quiet=args.quiet), report_finished=False)
    cmd_sync(argparse.Namespace(db=args.db, quiet=args.quiet))

    print("\n[3/4] Starting the agent...")
    if is_daemon_running():
        print("A daemon is already running on this machine.")
    else:
        command = daemon_command()
        if command and spawn_detached(command):
            print("Daemon started.")
        else:
            print("Could not start the daemon automatically; run `meterhouse daemon` by hand.")

    print("\n[4/4] Keeping it running across reboots...")
    if os.name == "nt":
        _register_supervisor_task()
    else:
        print("No scheduled-task equivalent is wired up on this OS yet — keep the "
              "daemon alive yourself (e.g. systemd/launchd), or re-run "
              "`meterhouse connect` after each reboot.")

    print("\nConnected. Run `meterhouse status` any time to check on it.\n")


def cmd_health(args):
    from .health import HealthState
    state = HealthState.load()
    if state is None:
        print("No daemon health data yet. Run `meterhouse daemon` (or wait for "
              "the scheduled task to start one).")
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
        help="scan continuously (config: runtime.json) + optional real-time push",
    )
    dm.add_argument("--display-name", default=None)
    dm.set_defaults(func=cmd_daemon)

    sub.add_parser(
        "status", help="is a daemon running, and what does it last report"
    ).set_defaults(func=cmd_status)
    sub.add_parser(
        "stop", help="stop a locally running daemon (the scheduled task relaunches it)"
    ).set_defaults(func=cmd_stop)

    sub.add_parser("health", help="show the daemon's full diagnostics snapshot").set_defaults(
        func=cmd_health
    )

    cn = sub.add_parser(
        "connect",
        help="one command: register + scan + sync + start daemon "
             "(+ scheduled task on Windows)",
    )
    cn.add_argument("--server", required=True, help="central API base URL")
    cn.add_argument("--api-key", required=True, help="agent API key (from admin)")
    cn.add_argument("--display-name", default=None)
    cn.add_argument("--ws-url", default=None,
                    help="enable real-time push over this WebSocket URL (optional)")
    cn.add_argument("--account", action="store_true",
                    help="also enable Claude account reporting")
    cn.add_argument("--quiet", action="store_true")
    cn.set_defaults(func=cmd_connect)

    return p


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
