"""Argument sanitising for `meterhouse register`.

The dashboard emits a PowerShell-quoted setup block. Pasted into cmd.exe the
single quotes are not stripped by the shell, so they arrive as part of the
argument value. Without this handling the agent stored `'https://host'` as its
server URL and every later call failed with an error that pointed nowhere near
the real cause.
"""

from meterhouse.cli import _unquote


class TestUnquote:
    def test_strips_single_quotes(self):
        assert _unquote("'https://meterhouse.netlify.app'") == "https://meterhouse.netlify.app"

    def test_strips_double_quotes(self):
        assert _unquote('"cfk_abc123"') == "cfk_abc123"

    def test_leaves_unquoted_values_alone(self):
        assert _unquote("https://meterhouse.netlify.app") == "https://meterhouse.netlify.app"

    def test_trims_surrounding_whitespace(self):
        assert _unquote("  https://host  ") == "https://host"
        assert _unquote("  'https://host'  ") == "https://host"

    def test_passes_none_through(self):
        assert _unquote(None) is None

    def test_only_strips_a_matched_pair(self):
        # A stray leading quote is not a quoting mistake we can safely undo.
        assert _unquote("'https://host") == "'https://host"
        assert _unquote("https://host'") == "https://host'"

    def test_does_not_strip_mismatched_quotes(self):
        assert _unquote("'https://host\"") == "'https://host\""

    def test_strips_only_one_layer(self):
        assert _unquote("''https://host''") == "'https://host'"

    def test_handles_empty_and_bare_quotes(self):
        assert _unquote("") == ""
        assert _unquote("''") == ""


class TestRegisterRejectsNonUrls:
    """A value that is not an http(s) URL must fail loudly, not be saved."""

    def _run(self, monkeypatch, capsys, server):
        import meterhouse.cli as cli

        saved = {}
        monkeypatch.setattr(cli, "save_identity", lambda ident: saved.setdefault("ident", ident))

        class Args:
            pass

        args = Args()
        args.server = server
        args.api_key = "cfk_test"
        args.display_name = "PC"
        args.ws_url = None

        cli.cmd_register(args)
        return saved, capsys.readouterr().out

    def test_rejects_a_bare_hostname(self, monkeypatch, capsys):
        saved, out = self._run(monkeypatch, capsys, "meterhouse.netlify.app")
        assert "Invalid --server" in out
        assert saved == {}, "must not persist an unusable server URL"

    def test_rejects_a_quoted_bare_hostname(self, monkeypatch, capsys):
        saved, out = self._run(monkeypatch, capsys, "'meterhouse.netlify.app'")
        assert "Invalid --server" in out
        assert saved == {}
