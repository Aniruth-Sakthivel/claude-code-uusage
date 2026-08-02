import asyncio
import json

from meterhouse.config import AgentConfig
from meterhouse.health import HealthState
from meterhouse.ws_client import MAX_MESSAGE_BYTES, WSClient


def make_client(**overrides) -> WSClient:
    cfg = AgentConfig(**overrides)
    return WSClient(url="wss://example.com/ws", api_key="key-1", config=cfg, health=HealthState())


class FakeWSSender:
    """Fake connected socket: records everything passed to `send`."""

    def __init__(self):
        self.sent: list[str] = []

    async def send(self, data: str) -> None:
        self.sent.append(data)


class FakeWSReceiver:
    """Fake connected socket: an async iterator yielding preset raw frames."""

    def __init__(self, messages):
        self._messages = list(messages)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._messages:
            raise StopAsyncIteration
        return self._messages.pop(0)


async def _drain(coro_task, predicate, attempts=200):
    for _ in range(attempts):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition never became true")


# ── send() ────────────────────────────────────────────────────────────────────

def test_send_enqueues_and_marks_health_queue_depth():
    client = make_client()
    client.send({"type": "scan_result", "n": 1})
    assert len(client._queue) == 1
    assert client._health.offline_queue_depth == 1
    assert client._has_message.is_set()


def test_send_drops_oversized_message():
    client = make_client()
    huge = {"type": "scan_result", "blob": "x" * MAX_MESSAGE_BYTES}
    client.send(huge)
    assert len(client._queue) == 0
    assert not client._has_message.is_set()


# ── _backoff_delay ────────────────────────────────────────────────────────────

def test_backoff_delay_grows_and_is_jittered():
    client = make_client(
        retry_backoff_base_seconds=1.0, retry_backoff_max_seconds=60.0, retry_max_attempts=8
    )
    d1 = client._backoff_delay(1)
    assert 0.5 <= d1 <= 1.5  # base * 2^0, jitter [0.5x, 1.5x]

    d3 = client._backoff_delay(3)
    assert 2.0 <= d3 <= 6.0  # base * 2^2


def test_backoff_delay_caps_at_max_attempts_and_max_seconds():
    client = make_client(
        retry_backoff_base_seconds=1.0, retry_backoff_max_seconds=60.0, retry_max_attempts=8
    )
    # attempt way beyond retry_max_attempts must clamp, not grow unbounded.
    d = client._backoff_delay(1000)
    assert 30.0 <= d <= 90.0  # min(60, base*2^7=128) => 60, jitter [0.5x,1.5x]


# ── _sender_loop ──────────────────────────────────────────────────────────────

def test_sender_loop_drains_queue_in_order():
    async def scenario():
        client = make_client(ws_heartbeat_interval_seconds=10_000)
        client.send({"type": "t", "n": 1})
        client.send({"type": "t", "n": 2})
        ws = FakeWSSender()

        task = asyncio.create_task(client._sender_loop(ws))
        await _drain(task, lambda: len(ws.sent) >= 2)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        payloads = [json.loads(m)["n"] for m in ws.sent]
        assert payloads == [1, 2]

    asyncio.run(scenario())


def test_sender_loop_wakes_immediately_on_new_message():
    """Regression guard: the loop must react to send() without waiting for a
    fixed poll interval (previously it slept 0.2s when idle)."""

    async def scenario():
        client = make_client(ws_heartbeat_interval_seconds=10_000)
        ws = FakeWSSender()
        task = asyncio.create_task(client._sender_loop(ws))

        # Let the loop reach its idle wait (empty queue) first.
        await asyncio.sleep(0)
        assert ws.sent == []

        client.send({"type": "t", "n": 99})
        await _drain(task, lambda: len(ws.sent) == 1)

        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert json.loads(ws.sent[0])["n"] == 99

    asyncio.run(scenario())


def test_sender_loop_sends_heartbeat_when_due():
    async def scenario():
        client = make_client(ws_heartbeat_interval_seconds=0.0)
        ws = FakeWSSender()
        task = asyncio.create_task(client._sender_loop(ws))
        await _drain(task, lambda: len(ws.sent) >= 1)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert json.loads(ws.sent[0]) == {"type": "heartbeat"}

    asyncio.run(scenario())


# ── _receiver_loop ────────────────────────────────────────────────────────────

def test_receiver_loop_dispatches_command_messages():
    async def scenario():
        received = []

        async def on_command(message):
            received.append(message)

        client = WSClient(
            url="wss://x", api_key="k", config=AgentConfig(), health=HealthState(),
            on_command=on_command,
        )
        ws = FakeWSReceiver([
            "not valid json{",
            json.dumps({"no_type_field": True}),
            json.dumps(["array", "not", "a", "dict"]),
            json.dumps({"type": "command", "action": "scan_now"}),
        ])
        await client._receiver_loop(ws)

        assert len(received) == 1
        assert received[0]["action"] == "scan_now"

    asyncio.run(scenario())


def test_receiver_loop_swallows_command_handler_exceptions():
    async def scenario():
        async def bad_handler(message):
            raise RuntimeError("handler exploded")

        client = WSClient(
            url="wss://x", api_key="k", config=AgentConfig(), health=HealthState(),
            on_command=bad_handler,
        )
        ws = FakeWSReceiver([json.dumps({"type": "command", "action": "scan_now"})])
        await client._receiver_loop(ws)  # must not raise

    asyncio.run(scenario())


def test_receiver_loop_ignores_non_command_types():
    async def scenario():
        received = []

        async def on_command(message):
            received.append(message)

        client = WSClient(
            url="wss://x", api_key="k", config=AgentConfig(), health=HealthState(),
            on_command=on_command,
        )
        ws = FakeWSReceiver([json.dumps({"type": "ack"})])
        await client._receiver_loop(ws)
        assert received == []

    asyncio.run(scenario())
