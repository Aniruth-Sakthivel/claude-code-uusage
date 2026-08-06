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
from logging.handlers import RotatingFileHandler
from pathlib import Path


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


def configure_logging(
    level: str = "INFO",
    json_output: bool = True,
    log_file=None,
    stream: bool = True,
    max_bytes: int = 1_000_000,
    backups: int = 2,
) -> logging.Logger:
    """Idempotent: safe to call once at daemon startup.

    `log_file` matters more than it used to. The daemon is started detached and
    windowless by a Claude Code hook, so its stderr goes to DEVNULL — without a
    file, a background agent's entire history of scans, errors and shutdowns
    would be unobservable. Rotating, because this runs unattended for months.

    `stream=False` is for hook processes: their stderr belongs to Claude Code,
    and metering has no business writing to a user's session.
    """
    logger = logging.getLogger("meterhouse")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    logger.propagate = False

    if logger.handlers:
        return logger  # already configured (e.g. re-entrant call in tests)

    def _formatter() -> logging.Formatter:
        if json_output:
            return _JsonFormatter()
        return logging.Formatter("%(asctime)s %(levelname)-8s %(name)s: %(message)s")

    if stream:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(_formatter())
        logger.addHandler(handler)

    if log_file:
        try:
            path = Path(log_file)
            path.parent.mkdir(parents=True, exist_ok=True)
            file_handler = RotatingFileHandler(
                path, maxBytes=max_bytes, backupCount=backups, encoding="utf-8"
            )
            file_handler.setFormatter(_formatter())
            logger.addHandler(file_handler)
        except OSError:
            # An unwritable log path must not stop the agent from doing its job.
            pass

    if not logger.handlers:
        logger.addHandler(logging.NullHandler())
    return logger


def get_logger(name: str = "meterhouse") -> logging.Logger:
    return logging.getLogger(name)
