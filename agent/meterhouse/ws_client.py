"""WebSocket client — real-time push to the central server.

Entirely optional: the agent is fully functional without it (REST `scan` +
`sync` keep working on their own schedule). This only activates when
``AgentConfig.ws_enabled`` and ``ws_url`` are set, and the ``websockets``
package is installed (the ``[realtime]`` extra — local/offline mode stays
pure stdlib on purpose).

Design:
  - Protocol-level ping/pong (RFC 6455, handled by the `websockets` library
    via ``ping_interval``/``ping_timeout``) detects a dead connection even
    when no application data is flowing.
  - An application-level ``heartbeat`` message is sent independently, since
    the server displays "last seen" from application data, not raw TCP/WS
    liveness.
  - Reconnects with capped exponential backoff + jitter, indefinitely — a
    daemon should never permanently give up on connectivity.
  - Outbound messages sent while disconnected are queued (bounded) and
    flushed in order on reconnect, so a scan result during a brief network
    blip is not silently lost.
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from collections import deque
from typing import Any, Awaitable, Callable

from .config import AgentConfig
from .health import HealthState
from .logging_setup import get_logger

log = get_logger("meterhouse.ws")

CommandHandler = Callable[[dict], Awaitable[None]]

# Cap a single outbound frame so a pathological scan result can't balloon
# memory or exceed the server's maxPayload and get silently dropped.
MAX_MESSAGE_BYTES = 512_000


class WSClient:
    def __init__(
        self,
        url: str,
        api_key: str,
        config: AgentConfig,
        health: HealthState,
        on_command: CommandHandler | None = None,
    ) -> None:
        self._url = url
        self._api_key = api_key
        self._cfg = config
        self._health = health
        self._on_command = on_command
        self._queue: deque[dict] = deque(maxlen=config.offline_queue_max_items)
        self._ws = None
        self._stopped = asyncio.Event()
        self._connected = asyncio.Event()
        # Wakes the sender loop the moment a message is queued, instead of it
        # polling on a fixed interval while idle.
        self._has_message = asyncio.Event()

    def send(self, message: dict) -> None:
        """Non-blocking enqueue. Flushed immediately if connected, else queued."""
        encoded = json.dumps(message)
        if len(encoded.encode("utf-8")) > MAX_MESSAGE_BYTES:
            log.warning("dropping oversized ws message", extra={"type": message.get("type")})
            return
        self._queue.append(message)
        self._health.offline_queue_depth = len(self._queue)
        self._has_message.set()

    async def stop(self) -> None:
        self._stopped.set()
        if self._ws is not None:
            await self._ws.close()

    async def wait_connected(self, timeout: float | None = None) -> bool:
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def run(self) -> None:
        """Reconnect loop. Runs until :meth:`stop` is called."""
        try:
            import websockets  # deferred import: optional dependency
        except ImportError:
            log.error(
                "ws_enabled is set but the 'websockets' package is not installed; "
                "install with: pip install meterhouse-rotor[realtime]"
            )
            return

        attempt = 0
        while not self._stopped.is_set():
            try:
                headers = {"Authorization": f"Bearer {self._api_key}"}
                async with websockets.connect(
                    self._url,
                    additional_headers=headers,
                    ping_interval=self._cfg.ws_heartbeat_interval_seconds,
                    ping_timeout=self._cfg.ws_heartbeat_timeout_seconds,
                    open_timeout=self._cfg.ws_connect_timeout_seconds,
                    max_size=MAX_MESSAGE_BYTES + 4096,
                ) as ws:
                    self._ws = ws
                    attempt = 0
                    self._connected.set()
                    self._health.record_ws_connected()
                    log.info("ws connected", extra={"url": self._url})

                    await asyncio.gather(
                        self._sender_loop(ws),
                        self._receiver_loop(ws),
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - reconnect on anything, log why
                reason = f"{type(exc).__name__}: {exc}"
                log.warning("ws disconnected", extra={"reason": reason})
                self._health.record_ws_disconnected(reason)
            finally:
                self._connected.clear()
                self._ws = None

            if self._stopped.is_set():
                break

            attempt += 1
            self._health.record_ws_reconnect_attempt()
            delay = self._backoff_delay(attempt)
            log.info("ws reconnecting", extra={"attempt": attempt, "delay_seconds": delay})
            try:
                await asyncio.wait_for(self._stopped.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass  # normal path: delay elapsed, loop retries

    def _backoff_delay(self, attempt: int) -> float:
        capped_attempt = min(attempt, self._cfg.retry_max_attempts)
        base = self._cfg.retry_backoff_base_seconds * (2 ** (capped_attempt - 1))
        base = min(base, self._cfg.retry_backoff_max_seconds)
        return base * (0.5 + random.random())  # full jitter within [0.5x, 1.5x]

    async def _sender_loop(self, ws) -> None:
        heartbeat_interval = self._cfg.ws_heartbeat_interval_seconds
        # Anchor to connect time, NOT 0.0. `time.monotonic()` is an arbitrary
        # large reading (system uptime on most platforms), so comparing it
        # against 0.0 made the first iteration fire a heartbeat on any machine
        # up longer than the interval — and not on a freshly booted one. That
        # made behaviour, and the tests covering it, depend on host uptime.
        # The server already registers presence when the socket connects, so
        # the first heartbeat is due one full interval later.
        last_heartbeat = time.monotonic()
        while True:
            now = time.monotonic()
            if now - last_heartbeat >= heartbeat_interval:
                await ws.send(json.dumps({"type": "heartbeat"}))
                last_heartbeat = now

            if self._queue:
                message = self._queue.popleft()
                self._health.offline_queue_depth = len(self._queue)
                await ws.send(json.dumps(message))
                continue

            # Wake as soon as `send()` queues something, or at the next
            # heartbeat deadline — whichever comes first — rather than
            # polling on a fixed interval.
            remaining = heartbeat_interval - (time.monotonic() - last_heartbeat)
            try:
                await asyncio.wait_for(self._has_message.wait(), timeout=max(remaining, 0))
            except asyncio.TimeoutError:
                pass
            self._has_message.clear()

    async def _receiver_loop(self, ws) -> None:
        async for raw in ws:
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("received malformed ws message, ignoring")
                continue
            if not isinstance(message, dict) or "type" not in message:
                continue
            if message["type"] == "command" and self._on_command:
                try:
                    await self._on_command(message)
                except Exception:  # noqa: BLE001
                    log.exception("command handler failed", extra={"command": message})
