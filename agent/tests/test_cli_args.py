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


class TestNewSubcommands:
    """The hook entry point is wired into settings.json, so its argument
    contract is what Claude Code depends on."""

    def test_hook_accepts_each_event(self):
        from meterhouse.cli import build_parser

        parser = build_parser()
        for event in ("session-start", "session-end", "keepalive"):
            assert parser.parse_args(["hook", event]).event == event

    def test_hook_rejects_an_unknown_event(self):
        import pytest

        from meterhouse.cli import build_parser

        with pytest.raises(SystemExit):
            build_parser().parse_args(["hook", "not-an-event"])

    def test_daemon_takes_always_on(self):
        from meterhouse.cli import build_parser

        parser = build_parser()
        assert parser.parse_args(["daemon"]).always_on is False
        assert parser.parse_args(["daemon", "--always-on"]).always_on is True

    def test_hook_management_commands_exist(self):
        from meterhouse.cli import build_parser

        parser = build_parser()
        for name in ("install-hooks", "uninstall-hooks", "sessions"):
            assert parser.parse_args([name]).func is not None


class TestRegisterAdoptsTheServersSystemId:
    """The server's system_id is authoritative — resolved from the API key,
    never from anything the client sends — and it is the only id that exists
    anywhere in the dashboard's database. Before this, `cmd_register` printed
    it but never adopted it, so agent.json kept the locally-invented uuid4
    from `load_identity`'s first run forever, and `meterhouse identity` showed
    an id that matched nothing server-side."""

    def _run(self, monkeypatch, capsys, register_response):
        import meterhouse.cli as cli
        from meterhouse.identity import Identity

        saves = []
        local = Identity(
            system_id="locally-invented-uuid",
            installation_id="inst-1",
            hostname="test-host",
            display_name="PC",
            agent_version="0.1.0",
            created_at="2026-07-25T00:00:00+00:00",
        )
        monkeypatch.setattr(cli, "load_identity", lambda **kw: local)
        monkeypatch.setattr(cli, "save_identity", lambda ident: saves.append(vars(ident).copy()))

        class FakeClient:
            def __init__(self, *a, **k):
                pass

            def register(self, *a, **k):
                return register_response

        import meterhouse.sync as sync_mod
        monkeypatch.setattr(sync_mod, "SyncClient", FakeClient)

        class Args:
            pass

        args = Args()
        args.server = "https://central.example"
        args.api_key = "cfk_test"
        args.display_name = "PC"
        args.ws_url = None

        cli.cmd_register(args)
        return saves, capsys.readouterr().out

    def test_adopts_the_server_system_id(self, monkeypatch, capsys):
        saves, out = self._run(
            monkeypatch, capsys,
            {"system_id": "server-authoritative-id", "display_name": "PC"},
        )
        assert "server-authoritative-id" in out
        assert saves[-1]["system_id"] == "server-authoritative-id"

    def test_adopts_the_servers_deduplicated_display_name(self, monkeypatch, capsys):
        saves, _ = self._run(
            monkeypatch, capsys,
            {"system_id": "server-id", "display_name": "PC (2)"},
        )
        assert saves[-1]["display_name"] == "PC (2)"

    def test_a_failed_register_call_does_not_touch_the_local_id(self, monkeypatch, capsys):
        import meterhouse.cli as cli
        from meterhouse.identity import Identity
        from meterhouse.sync import SyncError

        saves = []
        local = Identity(
            system_id="locally-invented-uuid",
            installation_id="inst-1",
            hostname="test-host",
            display_name="PC",
            agent_version="0.1.0",
            created_at="2026-07-25T00:00:00+00:00",
        )
        monkeypatch.setattr(cli, "load_identity", lambda **kw: local)
        monkeypatch.setattr(cli, "save_identity", lambda ident: saves.append(vars(ident).copy()))

        class FailingClient:
            def __init__(self, *a, **k):
                pass

            def register(self, *a, **k):
                raise SyncError("offline")

        import meterhouse.sync as sync_mod
        monkeypatch.setattr(sync_mod, "SyncClient", FailingClient)

        class Args:
            pass

        args = Args()
        args.server = "https://central.example"
        args.api_key = "cfk_test"
        args.display_name = "PC"
        args.ws_url = None

        cli.cmd_register(args)
        # One save from before the (failed) network call; none after it.
        assert len(saves) == 1
        assert saves[0]["system_id"] == "locally-invented-uuid"
