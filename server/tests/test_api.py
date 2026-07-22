from tests.conftest import auth_header, make_event


def _create_system(client, admin_token, name):
    r = client.post("/api/v1/admin/systems", json={"display_name": name},
                    headers=auth_header(admin_token))
    assert r.status_code == 201, r.text
    body = r.json()
    return body["system"]["system_id"], body["api_key"]


def test_health(client):
    assert client.get("/api/v1/health").json()["status"] == "ok"


def test_login_and_me(client, admin_token):
    r = client.get("/api/v1/auth/me", headers=auth_header(admin_token))
    assert r.json()["role"] == "admin"


def test_login_bad_password(client, admin_token):
    # admin_token fixture registered the admin; a wrong password must 401.
    r = client.post("/api/v1/auth/login",
                    json={"email": "admin@test.local", "password": "wrong"})
    assert r.status_code == 401


def test_registration_open_then_closed(client):
    assert client.get("/api/v1/auth/registration-open").json()["open"] is True
    r = client.post("/api/v1/auth/register", json={
        "email": "first@test.local", "full_name": "First", "password": "password123"})
    assert r.status_code == 201 and "access_token" in r.json()
    # once a user exists, registration is closed
    assert client.get("/api/v1/auth/registration-open").json()["open"] is False
    r2 = client.post("/api/v1/auth/register", json={
        "email": "second@test.local", "full_name": "Second", "password": "password123"})
    assert r2.status_code == 403


def test_registered_admin_can_login_and_is_admin(client):
    client.post("/api/v1/auth/register", json={
        "email": "boss@test.local", "full_name": "Boss", "password": "password123"})
    tok = client.post("/api/v1/auth/login",
                      json={"email": "boss@test.local", "password": "password123"}).json()["access_token"]
    assert client.get("/api/v1/auth/me", headers=auth_header(tok)).json()["role"] == "admin"


def test_create_system_returns_key_once(client, admin_token):
    sid, key = _create_system(client, admin_token, "PC-01")
    assert key.startswith("cfk_")
    # listing keys never exposes the full key again
    r = client.get(f"/api/v1/admin/systems/{sid}/keys", headers=auth_header(admin_token))
    assert all("api_key" not in k for k in r.json())


def test_agent_sync_and_dedup(client, admin_token):
    sid, key = _create_system(client, admin_token, "PC-01")
    events = [make_event("m1"), make_event("m2", tokens=50)]
    r = client.post("/api/v1/usage/sync", json={"events": events},
                    headers=auth_header(key))
    assert r.json() == {"received": 2, "inserted": 2, "duplicates": 0, "failed": 0}
    # re-send same events -> all duplicates, nothing double counted
    r = client.post("/api/v1/usage/sync", json={"events": events},
                    headers=auth_header(key))
    assert r.json()["inserted"] == 0 and r.json()["duplicates"] == 2


def test_agent_sync_rejects_user_jwt(client, admin_token):
    _create_system(client, admin_token, "PC-01")
    r = client.post("/api/v1/usage/sync", json={"events": [make_event("m1")]},
                    headers=auth_header(admin_token))
    assert r.status_code == 401  # user token is not an agent key


def test_dashboard_summary_and_ranking(client, admin_token):
    s1, k1 = _create_system(client, admin_token, "PC-01")
    s2, k2 = _create_system(client, admin_token, "PC-02")
    client.post("/api/v1/usage/sync",
                json={"events": [make_event("a", tokens=100)]}, headers=auth_header(k1))
    client.post("/api/v1/usage/sync",
                json={"events": [make_event("b", tokens=400)]}, headers=auth_header(k2))
    summary = client.get("/api/v1/dashboard/summary", headers=auth_header(admin_token)).json()
    assert summary["total_tokens"] == 500
    assert summary["highest"]["display_name"] == "PC-02"
    ranking = client.get("/api/v1/dashboard/ranking?range=30d",
                         headers=auth_header(admin_token)).json()
    assert ranking[0]["display_name"] == "PC-02" and ranking[0]["pct"] == 80.0


def _create_user(client, admin_token, email, role, system_ids=()):
    r = client.post("/api/v1/admin/users", headers=auth_header(admin_token), json={
        "email": email, "full_name": email, "password": "password123",
        "role": role, "system_ids": list(system_ids)})
    assert r.status_code == 201, r.text
    return r.json()


def _login(client, email):
    return client.post("/api/v1/auth/login",
                       json={"email": email, "password": "password123"}).json()["access_token"]


def test_developer_only_sees_assigned_systems(client, admin_token):
    s1, k1 = _create_system(client, admin_token, "PC-01")
    s2, k2 = _create_system(client, admin_token, "PC-02")
    client.post("/api/v1/usage/sync", json={"events": [make_event("a", tokens=100)]},
                headers=auth_header(k1))
    client.post("/api/v1/usage/sync", json={"events": [make_event("b", tokens=400)]},
                headers=auth_header(k2))

    _create_user(client, admin_token, "dev@test.local", "developer", system_ids=[s1])
    dev = _login(client, "dev@test.local")

    systems = client.get("/api/v1/systems", headers=auth_header(dev)).json()
    ids = {s["system_id"] for s in systems}
    assert ids == {s1}                      # PC-02 is NOT visible

    # server-side scoping also applies to aggregates
    summary = client.get("/api/v1/dashboard/summary", headers=auth_header(dev)).json()
    assert summary["total_tokens"] == 100   # only PC-01's tokens
    assert summary["total_systems"] == 1


def test_developer_cannot_manage_users(client, admin_token):
    _create_user(client, admin_token, "dev@test.local", "developer")
    dev = _login(client, "dev@test.local")
    r = client.get("/api/v1/admin/users", headers=auth_header(dev))
    assert r.status_code == 403


def test_viewer_sees_all_but_cannot_admin(client, admin_token):
    _create_system(client, admin_token, "PC-01")
    _create_user(client, admin_token, "viewer@test.local", "viewer")
    viewer = _login(client, "viewer@test.local")
    assert client.get("/api/v1/systems", headers=auth_header(viewer)).status_code == 200
    assert client.post("/api/v1/admin/systems", json={"display_name": "x"},
                       headers=auth_header(viewer)).status_code == 403


def test_api_key_revoke_blocks_sync(client, admin_token):
    sid, key = _create_system(client, admin_token, "PC-01")
    keys = client.get(f"/api/v1/admin/systems/{sid}/keys",
                      headers=auth_header(admin_token)).json()
    client.delete(f"/api/v1/admin/keys/{keys[0]['id']}", headers=auth_header(admin_token))
    r = client.post("/api/v1/usage/sync", json={"events": [make_event("m1")]},
                    headers=auth_header(key))
    assert r.status_code == 401


def test_audit_log_records_actions(client, admin_token):
    _create_system(client, admin_token, "PC-01")
    audit = client.get("/api/v1/admin/audit", headers=auth_header(admin_token)).json()
    actions = {a["action"] for a in audit}
    assert "system.created" in actions and "auth.register_admin" in actions
