"""Cost estimation from token counts.

IMPORTANT: this is an *estimate* for observability. It is NOT a reading of
Anthropic's official Claude Max/Pro quota or billing. Rates are per-million
tokens and may drift; treat totals as relative activity, not an invoice.
"""

from __future__ import annotations

PRICING = {
    "claude-fable-5":    {"input": 10.00, "output": 50.00, "cache_read": 1.00, "cache_write": 12.50},
    "claude-mythos-5":   {"input": 10.00, "output": 50.00, "cache_read": 1.00, "cache_write": 12.50},
    "claude-opus-4-8":   {"input": 5.00, "output": 25.00, "cache_read": 0.50, "cache_write": 6.25},
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    "claude-haiku-4-5":  {"input": 1.00, "output":  5.00, "cache_read": 0.10, "cache_write": 1.25},
}

# Family fallbacks when an exact model id isn't in the table.
_FAMILY_DEFAULT = {
    "fable": "claude-fable-5",
    "mythos": "claude-mythos-5",
    "opus": "claude-opus-4-8",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5",
}


def get_pricing(model: str | None) -> dict | None:
    if not model:
        return None
    if model in PRICING:
        return PRICING[model]
    for key in PRICING:
        if model.startswith(key):
            return PRICING[key]
    m = model.lower()
    for fam, default_key in _FAMILY_DEFAULT.items():
        if fam in m:
            return PRICING[default_key]
    return None


def calc_cost(model: str | None, inp: int, out: int,
              cache_read: int, cache_creation: int) -> float:
    p = get_pricing(model)
    if not p:
        return 0.0
    return (
        inp * p["input"]
        + out * p["output"]
        + cache_read * p["cache_read"]
        + cache_creation * p["cache_write"]
    ) / 1_000_000


def fmt_tokens(n: int) -> str:
    n = n or 0
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def fmt_cost(c: float) -> str:
    return f"${c:.4f}"
