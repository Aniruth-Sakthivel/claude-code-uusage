"""Structured logging for the agent daemon.

Local-mode commands (scan/today/week/...) print human-readable output directly
and are untouched by this module. This is specifically for the long-running
`daemon` process, where operators need timestamped, greppable/parseable
records of scan duration, errors, and connection status rather than bare
print() calls scrolling by.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Structured extras (e.g. logger.info("scan done", extra={"duration_ms": 42}))
        for key, value in record.__dict__.items():
            if key in _RESERVED or key.startswith("_"):
                continue
            payload[key] = value
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


_RESERVED = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__.keys()) | {"message"}


def configure_logging(level: str = "INFO", json_output: bool = True) -> logging.Logger:
    """Idempotent: safe to call once at daemon startup."""
    logger = logging.getLogger("meterhouse")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    logger.propagate = False

    if logger.handlers:
        return logger  # already configured (e.g. re-entrant call in tests)

    handler = logging.StreamHandler(sys.stderr)
    if json_output:
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-8s %(name)s: %(message)s")
        )
    logger.addHandler(handler)
    return logger


def get_logger(name: str = "meterhouse") -> logging.Logger:
    return logging.getLogger(name)
