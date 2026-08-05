"""Long-running agent process: scheduled scanning + optional real-time push.

This is what `meterhouse daemon` runs (the install script points a Scheduled
Task at this, triggered once at logon, instead of spawning a fresh short-lived
process every N minutes — a WebSocket connection needs a process that stays
alive to hold it).

Responsibilities are split by module on purpose (each independently testable):
  - scanner.scan()   -- unchanged, does the actual transcript ingestion
  - sync.sync_store  -- unchanged, does the actual REST upload
  - ws_client.WSClient -- optional real-time status/metrics channel
  - health.HealthState -- what `meterhouse health` reports
  - config.AgentConfig -- all the tunables, no source edits required

Concurrency: a single :class:`asyncio.Lock` around each scan cycle guarantees
only one scan ever runs at a time, even if a cycle overruns its interval —
the next tick is skipped (and logged), not queued up behind it.
"""

from __future__ import annotations

import asyncio
import signal
import time
from datetime import date

from .activity import ActivityWatcher
from .config import AgentConfig
from .health import HealthState
from .identity import Identity, load_identity
from .lockfile import SingleInstanceLock
from .logging_setup import configure_logging, get_logger
from .scanner import scan as run_scan
from .store import Store, default_db_path

log = get_logger("meterhouse.daemon")

# How often the health file is refreshed. Deliberately independent of
# `scan_interval_seconds`: the supervisor task and `meterhouse health` both use
# the file's age to judge whether the agent is alive, and an operator raising
# the scan interval from the dashboard must not make a perfectly healthy daemon
# look dead.
HEALTH_HEARTBEAT_SECONDS = 30

# How often the transcript files are checked for activity while waiting out the
# scan interval. Short enough that starting a Claude session shows up on the
# dashboard within seconds; long enough that the stat sweep is irrelevant to
# CPU. Never longer than the scan interval — the wait is capped by whichever
# comes first.
ACTIVITY_POLL_SECONDS = 5


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
            asyncio.create_task(self._scan_once(trigger="command"))
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

        log.warning("unknown command", extra={"action": action})
        return "failed", f"unknown action: {action}"

    def _apply_config_patch(self, payload: dict) -> list[str]:
        """Apply an allowlisted subset of `AgentConfig` fields and persist.

        `scan_interval_seconds` takes effect on the very next tick — the scan
        loop re-reads `self._cfg.scan_interval_seconds` each iteration, and
        this mutates the same config object the loop holds. `ws_enabled` /
        `ws_url` are read only at daemon startup, so those need a restart to
        take effect; still applied and saved so the next start picks them up.
        """
        allowed = {
            "scan_interval_seconds",
            "ws_enabled",
            "session_titles_enabled",
            "account_reporting_enabled",
        }
        applied = []
        for key, value in payload.items():
            if key not in allowed:
                continue
            setattr(self._cfg, key, value)
            applied.append(key)
        if applied:
            self._cfg.validated()
            self._cfg.save()
        return applied

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

                scanned_at = self._health.last_scan_at
                await self._report_status_async(
                    "scanned",
                    f"{summary.get('events_inserted', 0)} new events",
                    last_scan_at=scanned_at,
                    last_scan_duration_ms=round(duration_ms, 1),
                )

                await self._sync_once()

                await self._report_status_async(
                    "idle",
                    f"next scan in {self._cfg.scan_interval_seconds}s",
                    last_scan_at=scanned_at,
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
            sync_store(store, client, verbose=False,
                       send_titles=self._cfg.session_titles_enabled)
        except SyncError as exc:
            log.warning("sync failed, will retry next cycle", extra={"reason": str(exc)})
        finally:
            store.close()

        # Runs even when there was nothing to sync above: a REST-only agent
        # (no WebSocket) otherwise has no path to ever receive a queued
        # command on an idle machine.
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

    async def _report_account_once(self) -> None:
        if not self._cfg.account_reporting_enabled:
            return
        if not self._ident.server_url or not self._ident.api_key:
            return
        from .account import collect_account_report
        from .sync import SyncClient, SyncError

        try:
            payload = collect_account_report(enabled=True)
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

    async def _scan_loop(self) -> None:
        """Scan on the interval, or as soon as someone starts using Claude.

        The interval is the floor, not the cadence. Waiting it out means a
        session that starts a second after a tick is invisible on the dashboard
        for a full interval, which is exactly when someone looks and concludes
        the agent is not running. The wait is therefore broken into short polls
        of the transcript files, and any change scans immediately.
        """
        while not self._stop.is_set():
            await self._scan_once(trigger="schedule")
            self._activity.mark_scanned()
            if not await self._wait_for_next_scan():
                return

    async def _wait_for_next_scan(self) -> bool:
        """Sleep until the next scan is due, or until Claude activity appears.

        Returns False when the daemon is stopping.
        """
        deadline = time.monotonic() + self._cfg.scan_interval_seconds
        loop = asyncio.get_running_loop()

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return True

            try:
                await asyncio.wait_for(
                    self._stop.wait(),
                    timeout=min(ACTIVITY_POLL_SECONDS, remaining),
                )
                return False  # stop requested
            except asyncio.TimeoutError:
                pass

            # Paused means the operator asked for no scheduled scans; activity
            # must not quietly override that.
            if self._paused.is_set():
                continue

            try:
                busy = await loop.run_in_executor(None, self._activity.changed)
            except Exception:  # noqa: BLE001 - a stat sweep must never stop the loop
                log.exception("activity check failed")
                continue

            if busy:
                log.info("claude activity detected, scanning early")
                await self._scan_once(trigger="activity")
                self._activity.mark_scanned()
                deadline = time.monotonic() + self._cfg.scan_interval_seconds

    async def _health_loop(self) -> None:
        """Keep the health file fresh between scans.

        Without this the file is only touched when a scan completes, so at a
        10-minute scan interval the agent looks unresponsive for nine of every
        ten minutes — to `meterhouse health`, and to the supervisor task that
        decides whether to relaunch it.
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

    async def run(self) -> None:
        log.info(
            "daemon starting",
            extra={
                "system_id": self._ident.system_id,
                "scan_interval_seconds": self._cfg.scan_interval_seconds,
                "ws_enabled": self._cfg.ws_enabled,
            },
        )
        await self._start_ws()
        self._health.save()
        # Publish the cadence immediately, so the dashboard can show this
        # machine's interval and next-scan countdown from the moment it starts
        # rather than only after the first scan completes.
        await self._report_status_async("idle", "agent started")

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._stop.set)
            except NotImplementedError:
                pass  # Windows doesn't support add_signal_handler for SIGTERM

        health_task = asyncio.create_task(self._health_loop())
        try:
            await self._scan_loop()
        finally:
            self._stop.set()
            health_task.cancel()
            if self._ws is not None:
                await self._ws.stop()
            log.info("daemon stopped")


def run_daemon(display_name: str | None = None, db_path=None) -> None:
    """Run the daemon, unless one is already running on this machine.

    The supervising scheduled task fires every few minutes precisely so a dead
    daemon comes back quickly; the lock is what makes that safe. Exiting quietly
    (not with an error) keeps Task Scheduler's history clean — a relaunch that
    finds a healthy daemon is the expected case, not a failure.
    """
    lock = SingleInstanceLock()
    if not lock.acquire():
        log.info("another meterhouse daemon is already running; exiting")
        return

    try:
        ident = load_identity(display_name=display_name)
        cfg = AgentConfig.load().validated()
        configure_logging(level=cfg.log_level, json_output=cfg.log_json)
        daemon = Daemon(cfg, ident, db_path=db_path)
        try:
            asyncio.run(daemon.run())
        except KeyboardInterrupt:
            pass
    finally:
        lock.release()
