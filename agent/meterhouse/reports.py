"""Read-only aggregation queries over the local usage_events table.

Kept separate from the CLI so the same queries can back a local dashboard later.
All grouping uses the precomputed ``day`` / ``model_family`` columns.
"""

from __future__ import annotations

from datetime import date, timedelta

from .pricing import calc_cost


def _rows(store, sql, params=()):
    return store.conn.execute(sql, params).fetchall()


def totals_for_day(store, day: str) -> dict:
    by_model = _rows(store, """
        SELECT COALESCE(NULLIF(model, ''), 'unknown') AS model,
               SUM(input_tokens) AS inp, SUM(output_tokens) AS out,
               SUM(cache_read_tokens) AS cr, SUM(cache_creation_tokens) AS cc,
               COUNT(*) AS events
        FROM usage_events WHERE day = ?
        GROUP BY model ORDER BY inp + out DESC
    """, (day,))
    sessions = _rows(store,
        "SELECT COUNT(DISTINCT session_id) AS c FROM usage_events WHERE day = ?",
        (day,))[0]["c"]
    return {"by_model": by_model, "sessions": sessions}


def all_time_stats(store) -> dict:
    totals = _rows(store, """
        SELECT SUM(input_tokens) AS inp, SUM(output_tokens) AS out,
               SUM(cache_read_tokens) AS cr, SUM(cache_creation_tokens) AS cc,
               COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
        FROM usage_events
    """)[0]
    by_model = _rows(store, """
        SELECT COALESCE(NULLIF(model, ''), 'unknown') AS model,
               SUM(input_tokens) AS inp, SUM(output_tokens) AS out,
               SUM(cache_read_tokens) AS cr, SUM(cache_creation_tokens) AS cc,
               COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
        FROM usage_events GROUP BY model ORDER BY inp + out DESC
    """)
    top_projects = _rows(store, """
        SELECT COALESCE(project_name, 'unknown') AS project,
               SUM(total_tokens) AS tokens, COUNT(DISTINCT session_id) AS sessions
        FROM usage_events GROUP BY project ORDER BY tokens DESC LIMIT 10
    """)
    return {"totals": totals, "by_model": by_model, "top_projects": top_projects}


def last_n_days(store, n: int = 7) -> list:
    start = (date.today() - timedelta(days=n - 1)).isoformat()
    return _rows(store, """
        SELECT day, SUM(total_tokens) AS tokens, COUNT(*) AS events
        FROM usage_events WHERE day >= ? GROUP BY day ORDER BY day
    """, (start,))


def cost_of(rows) -> float:
    """Sum estimated cost across by-model rows (each has model/inp/out/cr/cc)."""
    return sum(
        calc_cost(r["model"], r["inp"] or 0, r["out"] or 0,
                  r["cr"] or 0, r["cc"] or 0)
        for r in rows
    )
