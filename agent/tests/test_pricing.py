from claudefleet import pricing


def test_exact_model_pricing():
    c = pricing.calc_cost("claude-opus-4-8", 1_000_000, 0, 0, 0)
    assert round(c, 4) == 5.00  # $5/M input


def test_output_and_cache_priced():
    c = pricing.calc_cost("claude-opus-4-8", 0, 1_000_000, 1_000_000, 1_000_000)
    # 25 (out) + 0.50 (cache_read) + 6.25 (cache_write)
    assert round(c, 4) == 31.75


def test_family_fallback_for_unknown_version():
    assert pricing.get_pricing("claude-sonnet-9-9") == pricing.PRICING["claude-sonnet-4-6"]
    assert pricing.get_pricing("something-opus-ish") == pricing.PRICING["claude-opus-4-8"]


def test_unknown_model_is_free_estimate():
    assert pricing.get_pricing("gpt-4") is None
    assert pricing.calc_cost("gpt-4", 1000, 1000, 0, 0) == 0.0


def test_fmt_tokens():
    assert pricing.fmt_tokens(999) == "999"
    assert pricing.fmt_tokens(1500) == "1.5K"
    assert pricing.fmt_tokens(2_500_000) == "2.50M"
