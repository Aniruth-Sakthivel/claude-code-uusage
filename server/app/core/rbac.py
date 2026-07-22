"""Role-based access control.

Roles are fixed and their capabilities live in one readable matrix. The key
server-side guarantee is :func:`visible_system_ids`: it returns the set of
systems a user may see, and every data query filters by it — so a developer
cannot reach an unassigned PC even by hand-crafting the request.
"""

from __future__ import annotations

from ..models import User

ADMIN = "admin"
MANAGER = "manager"
DEVELOPER = "developer"
VIEWER = "viewer"

ROLES = (ADMIN, MANAGER, DEVELOPER, VIEWER)

ROLE_DESCRIPTIONS = {
    ADMIN: "Full access: manage users, roles, systems, API keys, view audit logs.",
    MANAGER: "View all systems, analytics, and reports; no user/key management.",
    DEVELOPER: "View only assigned systems and their usage.",
    VIEWER: "Read-only access to all systems.",
}

# Capabilities checked in routers. Data *scoping* is separate (below).
CAPABILITIES = {
    ADMIN:     {"view_all", "manage_users", "manage_keys", "manage_systems",
                "view_audit", "export"},
    MANAGER:   {"view_all", "export"},
    DEVELOPER: set(),                    # sees only assigned systems
    VIEWER:    {"view_all"},
}


def can(user: User, capability: str) -> bool:
    return capability in CAPABILITIES.get(user.role.name, set())


def visible_system_ids(user: User) -> set[str] | None:
    """Systems this user may see. ``None`` means *all* (no filter)."""
    if user.role.name in (ADMIN, MANAGER, VIEWER):
        return None
    return {s.system_id for s in user.systems}   # developer: assigned only
