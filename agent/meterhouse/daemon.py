"""Always-on agent process: continuous scanning + optional real-time push.

This is what `meterhouse daemon` runs. There is exactly one lifecycle now —
no Claude Code session hooks, no "exit when idle" — a single process per
machine, launched once (by `install.ps1`, or by hand) and kept alive by an
OS-level supervisor (a Scheduled Task with a 1-minute repeating trigger; see
`deploy/install.ps1`) that repeatedly tries to (re)launch it. Every attempt
while a daemon is already running is a harmless, near-instant no-op — see
`run_daemon`'s use of `SingleInstanceLock` — which is what makes "just try
to start one, constantly" a safe supervision strategy rather than a source
of duplicate daemons.

The lifecycle, end to end:

  process starts -> acquire the single-instance lock (exit quietly if another
      daemon already holds it) -> scan on a fixed interval, forever
  explicit `stop`/`restart` Trigger command, or SIGINT/SIGTERM -> final
      scan + sync -> report "stopped" -> exit (the supervisor relaunches it
      within ~1 minute unless it was an explicit, deliberate `stop`)

Scanning and syncing run on independent cadences (`AgentConfig.
scan_interval_seconds` / `sync_interval_seconds`): every tick scans — cheap
and incremental, so a tight interval costs little — but a tick only pushes
to the server (`/usage/sync` + heartbeat + account report) when it actually
found something new, or the sync interval has elapsed. A full round trip on
every scan tick, forever, across a fleet, is not free; this keeps detection
latency tight without doing that.

Responsibilities are split by module on purpose (each independently testable):
  - scanner.scan()   -- unchanged, does the actual transcript ingestion
  - sync.sync_store  -- unchanged, does the actual REST upload
  - activity.count_recent -- the "active sessions" proxy (transcript recency,
    now that there is no hook-fed session registry to ask instead)
  - ws_client.WSClient -- optional real-time status/metrics channel
  - health.HealthState -- what `meterhouse health` reports
  - config.AgentConfig -- all the tunables, no source edits required

Concurrency: a single :class:`asyncio.Lock` around each scan cycle guarantees
only one scan ever runs at a time, even if a cycle overruns its interval —
the next tick is skipped (and logged), not queued up behind it.
"""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
import time
from dataclasses import asdict
from datetime import date
from pathlib import Path

from .activity import ActivityWatcher, count_recent
from .config import AgentConfig
from .health import HealthState
from .identity import Identity, load_identity
from .lockfile import SingleInstanceLock
from .logging_setup import configure_logging, get_logger
from .scanner import scan as run_scan
from .store import Store, default_db_path
from .watcher import validate_account_report, validate_scan_summary, validate_sync_result

log = get_logger("meterhouse.daemon")

# How often the health file is refreshed. Deliberately independent of
# `scan_interval_seconds`: the Scheduled Task supervisor and `meterhouse
# health` both use the file's age to judge whether the agent is alive, and an
# operator raising the scan interval from the dashboard must not make a
# perfectly healthy daemon look dead.
HEALTH_HEARTBEAT_SECONDS = 30

# The full diagnostics snapshot (health.py's HealthState, in full — not the
# curated subset `report_status` already sends on every state transition)
# rides along on every Nth health-loop tick rather than its own timer, so it
# stays roughly every HEALTH_HEARTBEAT_SECONDS * this many seconds (~5 min at
# the defaults) without adding a second scheduling loop.
HEALTH_REPORT_EVERY_N_TICKS = 10


def _process_metrics() -> dict:
    """Best-effort resource usage — stdlib only, degrades gracefully.

    `resource` is POSIX-only; on Windows this simply reports nulls rather than
    adding a third-party dependency (psutil) for a nice-to-have metric.
    """
    try:
        import resource

        usage = resource.getrusage(resource.RUSAGE_SELF)
        return {"max_rss_kb": usage.ru_maxrss, "user_cpu_seconds": usage.ru_utime}
    except ImportError:
        return {"max_rss_kb": None, "user_cpu_seconds": None}


def daemon_command() -> list[str] | None:
    """How to relaunch this agent as a daemon, for the way it was installed.

    Frozen builds re-exec the bundled exe. Source installs prefer
    `pythonw.exe`/`pyw.exe`, the console-less interpreters — with plain
    `python.exe` a window flashes on screen every time this runs. Used by the
    `restart` Trigger command to spawn its own replacement before exiting.
    """
    if getattr(sys, "frozen", False):
        return [sys.executable, "daemon"]

    executable = Path(sys.executable)
    if not executable.exists():
        return None

    if os.name == "nt":
        windowless = executable.with_name(
            "pythonw.exe" if executable.stem.lower() != "py" else "pyw.exe"
        )
        if windowless.exists():
            executable = windowless

    return [str(executable), "-m", "meterhouse", "daemon"]


def spawn_detached(command: list[str]) -> bool:
    """Start a daemon process that survives this one exiting."""
    kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "cwd": str(Path.home()),
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NEW_PROCESS_GROUP
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    else:
        kwargs["start_new_session"] = True

    try:
        subprocess.Popen(command, **kwargs)  # noqa: S603 - argv built here, not from input
        return True
    except (OSError, ValueError):
        log.warning("could not spawn daemon", extra={"command": command})
        return False


class Daemon:
    def __init__(self, config: AgentConfig, identity: Identity, db_path=None) -> None:
        self._cfg = config
        self._ident = identity
        self._db_path = db_path or default_db_path()
        self._health = HealthState()
        self._scan_lock = asyncio.Lock()
        self._stop = asyncio.Event()
        self._paused = asyncio.Event()
        self._ws = None
        self._activity = ActivityWatcher()
        self._health_tick_count = 0
        # 0.0 so the very first tick always syncs immediately — a freshly
        # (re)started daemon should report in right away, not wait out a
        # full sync_interval_seconds first.
        self._last_sync_at = 0.0

    def _update_active_sessions(self) -> None:
        """Refresh the "active sessions" proxy from transcript recency.

        There is no hook-fed session registry to ask anymore; a recently
        modified transcript is the best available signal that someone is
        actively working. Errs toward 0 on failure — undercounting is far
        less misleading on a dashboard than a stuck stale number.
        """
        try:
            snapshot = self._activity.snapshot()
            self._health.active_sessions = count_recent(
                snapshot, self._cfg.session_idle_timeout_seconds
            )
        except Exception:  # noqa: BLE001 - a stat sweep must never stop the loop
            log.exception("activity snapshot failed")
            self._health.active_sessions = 0

    async def _run_command(self, message: dict) -> None:
        """Handle a server-pushed command, e.g.
        `{"type":"command","id":7,"action":"scan_now","payload":{}}`.

        Called for commands delivered either over WS (ws_client's receiver
        loop) or picked out of a REST heartbeat/sync response (see
        `_poll_commands`) — either way this is the single execution path, and
        acks back over REST regardless of which transport delivered it.
        """
        command_id = message.get("id")
        status, detail = await self._execute_command(message)
        if command_id is not None:
            self._ack_command(command_id, status, detail)

    async def _execute_command(self, message: dict) -> tuple[str, str]:
        action = message.get("action")
        payload = message.get("payload") or {}

        if action == "scan_now":
            log.info("scan_now command received")
            asyncio.create_task(self._scan_and_sync(trigger="command"))
            return "acked", "scan queued"

        if action == "pause":
            self._paused.set()
            log.info("daemon paused by command")
            await self._report_status_async("paused", "scheduled scans paused")
            return "acked", "scan loop paused"

        if action == "resume":
            self._paused.clear()
            log.info("daemon resumed by command")
            await self._report_status_async("idle", "scheduled scans resumed")
            return "acked", "scan loop resumed"

        if action == "set_config":
            try:
                applied = self._apply_config_patch(payload)
            except Exception as exc:  # noqa: BLE001 - report, don't crash the daemon
                log.exception("set_config command failed")
                return "failed", f"{type(exc).__name__}: {exc}"
            detail = f"applied: {', '.join(applied)}" if applied else "no recognized fields"
            log.info("config updated by command", extra={"fields": applied})
            return "acked", detail

        if action == "stop":
            # Distinct from `pause`: pause keeps the process alive and only
            # skips scheduled scans. `stop` ends the process outright — the
            # only other way to end it now is killing it directly. The
            # Scheduled Task supervisor relaunches it within ~1 minute
            # regardless, so this is a real but temporary stop, not a
            # permanent uninstall.
            log.info("stop command received; shutting down")
            self._stop.set()
            return "acked", "shutting down"

        if action == "force_sync":
            log.info("force_sync command received")
            asyncio.create_task(self._sync_once())
            return "acked", "sync queued"

        if action == "refresh_data":
            log.info("refresh_data command received")
            asyncio.create_task(self._scan_and_sync(trigger="command"))
            asyncio.create_task(self._report_account_once(force=True))
            return "acked", "refresh queued"

        if action == "restart":
            command = daemon_command()
            spawned = bool(command) and spawn_detached(command)
            if not spawned:
                log.warning("restart command could not spawn a replacement process")
                return "failed", "could not spawn a replacement process"
            log.info("restart command received; spawning replacement and shutting down")
            self._stop.set()
            return "acked", "restart requested"

        if action == "health_check":
            if not (self._ident.server_url and self._ident.api_key):
                return "failed", "central mode not configured"
            log.info("health_check command received")
            asyncio.create_task(self._push_health_snapshot())
            return "acked", "health snapshot sent"

        log.warning("unknown command", extra={"action": action})
        return "failed", f"unknown action: {action}"

    def _apply_config_patch(self, payload: dict) -> list[str]:
        """Apply an allowlisted subset of `AgentConfig` fields and persist.

        `scan_interval_seconds`/`sync_interval_seconds` take effect on the
        very next tick — the loop re-reads `self._cfg` each iteration, and
        this mutates the same config object it holds. `ws_enabled`/`ws_url`
        are read only at daemon startup, so those need a restart to take
        effect; still applied and saved so the next start picks them up.

        The allowlist and clamping live on `AgentConfig` so the one-shot CLI
        path applies exactly the same rules — see `AgentConfig.apply_patch`.
        """
        return self._cfg.apply_patch(payload)

    def _ack_command(self, command_id, status: str, detail: str) -> None:
        if not self._ident.server_url or not self._ident.api_key:
            return
        from .sync import SyncClient, SyncError

        try:
            SyncClient(
                self._ident.server_url, self._ident.api_key, timeout=self._cfg.http_timeout_seconds
            ).ack_command(command_id, status, detail)
        except SyncError as exc:
            log.warning("command ack failed", extra={"command_id": command_id, "reason": str(exc)})

    async def _push_health_snapshot(self) -> None:
        """Push the full local `HealthState` for the diagnostics view.

        Distinct from `_report_status`: that's a curated per-transition
        subset sent often; this is the complete picture (scan counts, WS
        state, offline queue depth, validation issues), sent rarely — every
        `HEALTH_REPORT_EVERY_N_TICKS`th health-loop tick, or on demand via
        the `health_check` command. Best-effort: diagnostics must never
        affect the health loop's own reliability.
        """
        if not (self._ident.server_url and self._ident.api_key):
            return
        from .sync import SyncClient, SyncError

        loop = asyncio.get_running_loop()
        try:
            client = SyncClient(
                self._ident.server_url, self._ident.api_key, timeout=self._cfg.http_timeout_seconds
            )
            await loop.run_in_executor(None, lambda: client.report_health(asdict(self._health)))
        except SyncError as exc:
            log.warning("health snapshot push failed", extra={"reason": str(exc)})
        except Exception:  # noqa: BLE001 - diagnostics must never stop the daemon
            log.exception("health snapshot push failed")

    def _report_status(self, state: str, detail: str = "", **extra) -> None:
        """Push a status line to the dashboard, best effort.

        Runs on the event loop thread but is bounded by the HTTP timeout, and
        every failure is swallowed: a dashboard that cannot be told about a
        scan must never prevent the scan.
        """
        if not (self._ident.server_url and self._ident.api_key):
            return
        from .sync import SyncClient

        try:
            SyncClient(
                self._ident.server_url,
                self._ident.api_key,
                timeout=self._cfg.http_timeout_seconds,
            ).report_status(
                state,
                detail,
                scan_interval_seconds=self._cfg.scan_interval_seconds,
                active_sessions=self._health.active_sessions,
                **extra,
            )
        except Exception:  # noqa: BLE001 - status is diagnostics, never critical
            log.debug("status report failed", extra={"state": state})

    async def _report_status_async(self, state: str, detail: str = "", **extra) -> None:
        # Local-only agents have nowhere to report to: return without so much as
        # a thread-pool round trip, so the scan starts as promptly as it did
        # before status reporting existed.
        if not (self._ident.server_url and self._ident.api_key):
            return
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, lambda: self._report_status(state, detail, **extra))

    async def _scan_once(self, trigger: str) -> dict | None:
        """Scan only — does not sync. See `_scan_and_sync` for the common
        "scan then push" case; the tick loop calls this directly so it can
        decide independently whether this tick is also a sync tick."""
        # `pause`/`resume` commands only affect the schedule; a `scan_now`
        # command (trigger="command") still runs on request even while paused.
        if trigger == "schedule" and self._paused.is_set():
            log.debug("scan skipped: daemon paused")
            return None

        if self._scan_lock.locked():
            log.info("scan already running, skipping this tick", extra={"trigger": trigger})
            return None

        async with self._scan_lock:
            start = time.monotonic()
            await self._report_status_async("scanning", f"trigger={trigger}")
            try:
                loop = asyncio.get_running_loop()
                summary = await loop.run_in_executor(
                    None,
                    lambda: run_scan(
                        system_id=self._ident.system_id, db_path=self._db_path, verbose=False
                    ),
                )
                duration_ms = (time.monotonic() - start) * 1000
                self._health.record_scan(duration_ms)
                log.info(
                    "scan complete",
                    extra={"trigger": trigger, "duration_ms": round(duration_ms, 1), **summary},
                )
                for issue in validate_scan_summary(summary):
                    log.warning("scan validation issue", extra={"issue": issue})
                    self._health.record_validation_issue(issue)

                if self._ws is not None:
                    self._ws.send(
                        {
                            "type": "scan_result",
                            "trigger": trigger,
                            "duration_ms": round(duration_ms, 1),
                            "day": date.today().isoformat(),
                            **summary,
                            **_process_metrics(),
                        }
                    )

                await self._report_status_async(
                    "scanned",
                    f"{summary.get('events_inserted', 0)} new events",
                    last_scan_at=self._health.last_scan_at,
                    last_scan_duration_ms=round(duration_ms, 1),
                )
                return summary
            except Exception as exc:  # noqa: BLE001 - never let a bad scan kill the daemon
                duration_ms = (time.monotonic() - start) * 1000
                reason = f"{type(exc).__name__}: {exc}"
                self._health.record_scan(duration_ms, error=reason)
                log.exception("scan failed", extra={"trigger": trigger})
                if self._ws is not None:
                    self._ws.send({"type": "alert", "level": "error", "message": reason})
                await self._report_status_async("error", reason)
                return None
            finally:
                # Best-effort: a health file the daemon can't write (e.g. disk
                # full, permissions) must never take down the scan loop itself.
                try:
                    self._health.save()
                except Exception:  # noqa: BLE001
                    log.exception("failed to persist health state")

    async def _scan_and_sync(self, trigger: str) -> dict | None:
        """Scan, then always push regardless of the sync interval — used by
        explicit triggers (a manual `scan_now`/`refresh_data` command, the
        final scan on shutdown) where "I asked for this, show it to me now"
        is the whole point, unlike a routine schedule tick."""
        summary = await self._scan_once(trigger)
        await self._sync_once()
        self._last_sync_at = time.monotonic()
        await self._report_status_async(
            "idle",
            f"next scan in {self._cfg.scan_interval_seconds}s",
            last_scan_at=self._health.last_scan_at,
            last_scan_duration_ms=self._health.last_scan_duration_ms,
        )
        return summary

    async def _sync_once(self) -> None:
        if not self._ident.server_url or not self._ident.api_key:
            return  # local-only mode: scanning still ran, nothing to push over REST
        from .sync import SyncClient, SyncError, sync_store

        client = SyncClient(
            self._ident.server_url, self._ident.api_key, timeout=self._cfg.http_timeout_seconds
        )
        await self._report_status_async("syncing", "pushing usage to the dashboard")
        store = Store(self._db_path)
        try:
            totals = sync_store(store, client, verbose=False,
                                 send_titles=self._cfg.session_titles_enabled)
            for issue in validate_sync_result(totals):
                log.warning("sync validation issue", extra={"issue": issue})
                self._health.record_validation_issue(issue)
        except SyncError as exc:
            log.warning("sync failed, will retry next cycle", extra={"reason": str(exc)})
        finally:
            store.close()

        # Runs even when there was nothing to sync above: a REST-only agent
        # (no WebSocket) otherwise has no path to ever receive a queued
        # command on a quiet machine.
        await self._poll_commands(client)

        # Account reporting runs after usage sync and swallows its own errors:
        # this is an optional extra and must never cost us a usage push.
        await self._report_account_once()

    async def _poll_commands(self, client) -> None:
        from .sync import SyncError

        try:
            resp = client.heartbeat()
        except SyncError as exc:
            log.warning("heartbeat failed, will retry next cycle", extra={"reason": str(exc)})
            return
        for command in resp.get("commands", []):
            await self._run_command(command)

    async def _report_account_once(self, force: bool = False) -> None:
        """Report Claude account identity + rate-limit utilization.

        `force` bypasses the `account_reporting_enabled` gate for one call —
        used by the `refresh_data` command, which explicitly asks for a fresh
        account read regardless of the normal cadence/opt-in.
        """
        if not (self._cfg.account_reporting_enabled or force):
            return
        if not self._ident.server_url or not self._ident.api_key:
            return
        from .account import collect_account_report
        from .sync import SyncClient, SyncError

        try:
            payload = collect_account_report(enabled=True)
            for issue in validate_account_report(payload):
                log.warning("account report validation issue", extra={"issue": issue})
                self._health.record_validation_issue(issue)
            if payload is None:
                return  # not signed in, or nothing readable — nothing to say
            client = SyncClient(
                self._ident.server_url, self._ident.api_key, timeout=self._cfg.http_timeout_seconds
            )
            client.report_account(payload)
        except SyncError as exc:
            log.warning("account report failed", extra={"reason": str(exc)})
        except Exception as exc:  # noqa: BLE001 - never let this kill a scan cycle
            log.warning("account report skipped", extra={"reason": f"{type(exc).__name__}: {exc}"})

    async def _tick_loop(self) -> None:
        """Scan on a fixed interval, forever — no session gating.

        Every tick scans (cheap, incremental — see `scanner.scan`); only some
        ticks also sync, so a quiet machine is not making a full network
        round trip every `scan_interval_seconds` forever. A tick that found
        new events always syncs immediately regardless of the sync interval,
        so real activity is never delayed by it — see `AgentConfig.
        sync_interval_seconds`.
        """
        while not self._stop.is_set():
            self._update_active_sessions()
            summary = await self._scan_once(trigger="schedule")
            found_something = bool(summary and summary.get("events_inserted"))
            due_for_sync = (
                time.monotonic() - self._last_sync_at
            ) >= self._cfg.sync_interval_seconds

            if found_something or due_for_sync:
                await self._sync_once()
                self._last_sync_at = time.monotonic()
                await self._report_status_async(
                    "idle",
                    f"next scan in {self._cfg.scan_interval_seconds}s",
                    last_scan_at=self._health.last_scan_at,
                    last_scan_duration_ms=self._health.last_scan_duration_ms,
                )

            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._cfg.scan_interval_seconds)
            except asyncio.TimeoutError:
                pass

    async def _health_loop(self) -> None:
        """Keep the health file fresh between scans.

        Without this the file is only touched when a scan completes, so at a
        long scan interval the agent looks unresponsive for most of it — to
        `meterhouse health`, and to the Scheduled Task supervisor deciding
        whether to relaunch it.
        """
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=HEALTH_HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                pass
            if self._stop.is_set():
                return
            self._health.touch()
            try:
                self._health.save()
            except Exception:  # noqa: BLE001 - diagnostics must never stop the daemon
                log.exception("failed to persist health state")

            self._health_tick_count += 1
            if self._health_tick_count % HEALTH_REPORT_EVERY_N_TICKS == 0:
                await self._push_health_snapshot()

    async def _start_ws(self) -> None:
        if not (self._cfg.ws_enabled and self._cfg.ws_url and self._ident.api_key):
            return
        from .ws_client import WSClient

        self._ws = WSClient(
            url=self._cfg.ws_url,
            api_key=self._ident.api_key,
            config=self._cfg,
            health=self._health,
            on_command=self._run_command,
        )
        asyncio.create_task(self._ws.run())

    async def _shutdown(self) -> None:
        """Leave nothing behind: last tokens captured, dashboard told, exit."""
        try:
            await self._scan_and_sync(trigger="shutdown")
        except Exception:  # noqa: BLE001 - shutdown must complete regardless
            log.exception("final scan failed")

        # Reported last, and deliberately after the final scan's own "idle"
        # line, so this is the state the dashboard is left holding. A
        # deliberate `stop`/`restart` reports this the same way an ordinary
        # crash-free exit would — the Scheduled Task supervisor tells the two
        # apart by how quickly the daemon comes back, not by this line.
        self._health.record_stopped()
        await self._report_status_async(
            "stopped", "agent stopped", last_scan_at=self._health.last_scan_at
        )
        try:
            self._health.save()
        except Exception:  # noqa: BLE001
            log.exception("failed to persist health state")

    async def run(self) -> None:
        log.info(
            "daemon starting",
            extra={
                "system_id": self._ident.system_id,
                "scan_interval_seconds": self._cfg.scan_interval_seconds,
                "sync_interval_seconds": self._cfg.sync_interval_seconds,
                "ws_enabled": self._cfg.ws_enabled,
            },
        )

        await self._start_ws()
        self._update_active_sessions()
        self._health.save()
        # Publish the cadence immediately, so the dashboard can show this
        # machine's interval from the moment it starts rather than only
        # after the first scan completes.
        await self._report_status_async("idle", "agent started")

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._stop.set)
            except NotImplementedError:
                pass  # Windows doesn't support add_signal_handler for SIGTERM

        health_task = asyncio.create_task(self._health_loop())
        try:
            await self._tick_loop()
        finally:
            self._stop.set()
            health_task.cancel()
            await self._shutdown()
            if self._ws is not None:
                await self._ws.stop()
            log.info("daemon stopped")


def run_daemon(display_name: str | None = None, db_path=None) -> None:
    """Run the daemon, unless one is already running for this user.

    The lock is what lets the Scheduled Task supervisor fire blindly every
    minute: a launch that finds a healthy daemon already running exits
    immediately. Exiting quietly (not with an error) keeps that the expected
    case rather than a logged failure.

    The lock lives under the user's home, so concurrent users on a shared
    machine each get their own daemon and never contend.
    """
    lock = SingleInstanceLock()
    if not lock.acquire():
        log.info("another meterhouse daemon is already running; exiting")
        return

    try:
        ident = load_identity(display_name=display_name)
        cfg = AgentConfig.load().validated()
        configure_logging(
            level=cfg.log_level,
            json_output=cfg.log_json,
            log_file=cfg.resolved_log_file(),
            max_bytes=cfg.log_file_max_bytes,
            backups=cfg.log_file_backups,
        )
        daemon = Daemon(cfg, ident, db_path=db_path)
        try:
            asyncio.run(daemon.run())
        except KeyboardInterrupt:
            pass
    finally:
        lock.release()
