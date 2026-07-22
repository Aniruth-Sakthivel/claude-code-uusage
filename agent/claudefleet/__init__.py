"""ClaudeFleet local agent.

Original software (not derived from any third-party project). Scans Claude Code
JSONL transcripts on the local machine, stores a centralization-ready usage
record in local SQLite, and (later) syncs it to the central API.

The JSONL layout it reads is Claude Code's own on-disk data format, independently
observed from real transcripts (see docs/UPSTREAM_AUDIT.md for the format spec).
"""

__version__ = "0.1.0"
