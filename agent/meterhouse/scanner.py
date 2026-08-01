"""Incremental scan orchestration.

Walks the Claude Code transcript directories, reads only new/changed files (and
within a changed file, only new lines), parses them into events, and stores them
idempotently. Safe to run repeatedly and while Claude Code is actively writing.
"""

from __future__ import annotations

import glob
import os
from pathlib import Path

from .parser import parse_lines
from .store import Store, default_db_path

# Windows: Path.home() resolves to %USERPROFILE%, so this is
# C:\\Users\\<you>\\.claude\\projects — confirmed on-disk.
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
XCODE_PROJECTS_DIR = (
    Path.home() / "Library" / "Developer" / "Xcode"
    / "CodingAssistant" / "ClaudeAgentConfig" / "projects"
)
DEFAULT_PROJECT_DIRS = [CLAUDE_PROJECTS_DIR, XCODE_PROJECTS_DIR]


def discover_files(project_dirs=None) -> list[str]:
    dirs = project_dirs if project_dirs is not None else DEFAULT_PROJECT_DIRS
    files: list[str] = []
    for d in dirs:
        d = Path(d)
        if not d.exists():
            continue
        files.extend(glob.glob(str(d / "**" / "*.jsonl"), recursive=True))
    files.sort()
    return files


def scan(*, system_id: str, db_path=None, project_dirs=None,
         verbose: bool = False) -> dict:
    """Run one incremental scan pass.

    Returns a summary: ``{new, updated, skipped, events_inserted}``.
    """
    store = Store(db_path or default_db_path())
    summary = {"new": 0, "updated": 0, "skipped": 0, "events_inserted": 0}

    try:
        for path in discover_files(project_dirs):
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue

            row = store.get_scanned_file(path)
            if row is not None and abs(row["mtime"] - mtime) < 0.01:
                summary["skipped"] += 1
                continue

            is_new = row is None
            start_line = 0 if is_new else (row["line_count"] or 0)

            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    result = parse_lines(
                        f, system_id=system_id, source_file=path,
                        start_line=start_line)
            except OSError as e:
                if verbose:
                    print(f"  warning: cannot read {path}: {e}")
                continue

            # File's mtime changed but it did not actually grow past the
            # watermark (e.g. touched, or a partial line rewritten): just refresh
            # the stored mtime and move on.
            if not is_new and result.line_count <= start_line:
                store.set_scanned_file(path, mtime, start_line)
                store.commit()
                summary["skipped"] += 1
                continue

            inserted = store.insert_events(result.events)
            # Prompts and titles are stored locally on every scan; whether they
            # are ever transmitted is a separate, opt-in decision at sync time.
            prompts_inserted = store.insert_prompts(result.prompts)
            store.upsert_session_titles(
                {sid: meta["topic"] for sid, meta in result.sessions.items() if meta.get("topic")}
            )
            store.set_scanned_file(path, mtime, result.line_count)
            store.commit()

            summary["events_inserted"] += inserted
            summary["prompts_inserted"] = summary.get("prompts_inserted", 0) + prompts_inserted
            if is_new:
                summary["new"] += 1
            else:
                summary["updated"] += 1
            if verbose:
                tag = "NEW" if is_new else "UPD"
                print(f"  [{tag}] {path}  (+{inserted} events)")
    finally:
        store.close()

    if verbose:
        print(
            f"scan complete: new={summary['new']} updated={summary['updated']} "
            f"skipped={summary['skipped']} events+={summary['events_inserted']}")
    return summary
