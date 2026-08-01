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

from .config import AgentConfig
from .health import HealthState
from .identity import Identity, load_identity
from .logging_setup import configure_logging, get_logger
from .scanner import scan as run_scan
from .store import Store, default_db_path

log = get_logger("meterhouse.daemon")


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
        self._ws = None

    async def _run_command(self, message: dict) -> None:
        """Handle a server-pushed command, e.g. `{"type":"command","action":"scan_now"}`."""
        action = message.get("action")
        if action == "scan_now":
            log.info("scan_now command received")
            asyncio.create_task(self._scan_once(trigger="command"))
        else:
            log.warning("unknown command", extra={"action": action})

    async def _scan_once(self, trigger: str) -> dict | None:
        if self._scan_lock.locked():
            log.info("scan already running, skipping this tick", extra={"trigger": trigger})
            return None

        async with self._scan_lock:
            start = time.monotonic()
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

                await self._sync_once()
                return summary
            except Exception as exc:  # noqa: BLE001 - never let a bad scan kill the daemon
                duration_ms = (time.monotonic() - start) * 1000
                reason = f"{type(exc).__name__}: {exc}"
                self._health.record_scan(duration_ms, error=reason)
                log.exception("scan failed", extra={"trigger": trigger})
                if self._ws is not None:
                    self._ws.send({"type": "alert", "level": "error", "message": reason})
                return None
            finally:
                self._health.save()

    async def _sync_once(self) -> None:
        if not self._ident.server_url or not self._ident.api_key:
            return  # local-only mode: scanning still ran, nothing to push over REST
        from .sync import SyncClient, SyncError, sync_store

        store = Store(self._db_path)
        try:
            client = SyncClient(
                self._ident.server_url, self._ident.api_key, timeout=self._cfg.http_timeout_seconds
            )
            sync_store(store, client, verbose=False,
                       send_titles=self._cfg.session_titles_enabled)
        except SyncError as exc:
            log.warning("sync failed, will retry next cycle", extra={"reason": str(exc)})
        finally:
            store.close()

        # Account reporting runs after usage sync and swallows its own errors:
        # this is an optional extra and must never cost us a usage push.
        await self._report_account_once()

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
        while not self._stop.is_set():
            await self._scan_once(trigger="schedule")
            try:
                await asyncio.wait_for(
                    self._stop.wait(), timeout=self._cfg.scan_interval_seconds
                )
            except asyncio.TimeoutError:
                pass

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

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._stop.set)
            except NotImplementedError:
                pass  # Windows doesn't support add_signal_handler for SIGTERM

        try:
            await self._scan_loop()
        finally:
            if self._ws is not None:
                await self._ws.stop()
            log.info("daemon stopped")


def run_daemon(display_name: str | None = None, db_path=None) -> None:
    ident = load_identity(display_name=display_name)
    cfg = AgentConfig.load().validated()
    configure_logging(level=cfg.log_level, json_output=cfg.log_json)
    daemon = Daemon(cfg, ident, db_path=db_path)
    try:
        asyncio.run(daemon.run())
    except KeyboardInterrupt:
        pass
