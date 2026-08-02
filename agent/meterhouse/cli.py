"""Meterhouse agent CLI (local mode).

    python -m meterhouse scan       # ingest new/changed transcripts
    python -m meterhouse today      # today's usage by model
    python -m meterhouse week       # last 7 days
    python -m meterhouse stats      # all-time statistics
    python -m meterhouse identity   # show this machine's system_id

Local mode needs no central server. Central-mode commands (register/sync/
heartbeat) push usage to a central dashboard; see `--help` for each.

`daemon` runs continuously: scans on a timer (default 60s, configurable via
runtime.json or METERHOUSE_* env vars) and, if configured, holds a WebSocket
open for real-time status push. `health` reports the daemon's last-known
state.
"""

from __future__ import annotations

import argparse
import json
from datetime import date

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


def cmd_scan(args):
    ident = load_identity(display_name=args.display_name)
    summary = run_scan(system_id=ident.system_id, db_path=args.db,
                       verbose=not args.quiet)
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


def cmd_register(args):
    from .config import AgentConfig
    from .sync import SyncClient, SyncError, warn_if_insecure
    ident = load_identity(display_name=args.display_name)
    ident.server_url = args.server.rstrip("/")
    ident.api_key = args.api_key

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


def cmd_sync(args):
    from .sync import SyncClient, SyncError, sync_store
    ident = load_identity()
    if not ident.server_url or not ident.api_key:
        print("Central mode not configured. Run: meterhouse register "
              "--server URL --api-key KEY")
        return
    store = Store(args.db or default_db_path())
    try:
        client = SyncClient(ident.server_url, ident.api_key)
        totals = sync_store(store, client, verbose=not args.quiet,
                            send_titles=AgentConfig.load().session_titles_enabled)
        print(f"Sync complete: inserted={totals['inserted']} "
              f"duplicates={totals['duplicates']} (sent={totals['received']}).")
    except SyncError as e:
        print(f"Sync failed (offline?) - will retry next run: {e}")
    finally:
        store.close()


def cmd_daemon(args):
    from .daemon import run_daemon
    run_daemon(display_name=args.display_name, db_path=args.db)


def cmd_health(args):
    from .health import HealthState
    state = HealthState.load()
    if state is None:
        print("No daemon health data yet — is `meterhouse daemon` running?")
        return
    print()
    _hr()
    print("  Meterhouse daemon health")
    _hr()
    print(f"  PID:                 {state.pid}")
    print(f"  Started:             {state.started_at}")
    print(f"  Last update:         {state.updated_at}")
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
        print("  Run `meterhouse account show` to see exactly what will be sent.\n")
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
        help="run continuously: scheduled scans (config: runtime.json) + optional real-time push",
    )
    dm.add_argument("--display-name", default=None)
    dm.set_defaults(func=cmd_daemon)

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
