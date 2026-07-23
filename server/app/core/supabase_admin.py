"""Server-side Supabase admin client (service_role key — never exposed to the frontend).

Used only to provision/manage Supabase Auth users when an admin creates or
edits an account from the dashboard. Local password hashing is retired;
Supabase Auth is the source of truth for credentials.
"""

from __future__ import annotations

from functools import lru_cache

from supabase import Client, create_client

from ..config import get_settings


@lru_cache
def get_admin_client() -> Client:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise RuntimeError(
            "CLAUDEFLEET_SUPABASE_URL / CLAUDEFLEET_SUPABASE_SERVICE_ROLE_KEY "
            "must be set to manage users.")
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


def create_auth_user(email: str, password: str) -> str:
    """Create a Supabase Auth user (email confirmed, since an admin set the password). Returns the Supabase user id."""
    resp = get_admin_client().auth.admin.create_user({
        "email": email, "password": password, "email_confirm": True,
    })
    return resp.user.id


def find_auth_user_by_email(email: str) -> str | None:
    """Return the Supabase user id for this email if an Auth account already
    exists (e.g. the local DB was reset but Supabase Auth wasn't), else None."""
    page = get_admin_client().auth.admin.list_users()
    for user in page:
        if user.email == email:
            return user.id
    return None


def update_auth_user_password(supabase_user_id: str, password: str) -> None:
    get_admin_client().auth.admin.update_user_by_id(
        supabase_user_id, {"password": password})


def delete_auth_user(supabase_user_id: str) -> None:
    get_admin_client().auth.admin.delete_user(supabase_user_id)
