/**
 * Admin-only controls for one user: edit name, change role, enable/disable,
 * delete. Migrated out of the old flat AdminUsers table onto the User
 * Details page's Overview tab, since a card grid has no room for inline
 * actions and each user now has a dedicated page to hold them.
 */

import { useEffect, useState } from "react";

import type { Role, UpdateUserPayload, User } from "../../api/types";
import { ROLES } from "../../lib/roles";
import { Badge, Button, Card, CardHead, ConfirmDialog, Field, Input, Select } from "../ui";

export function AdminUserActionsPanel({
  user,
  isSelf,
  onUpdate,
  updating,
  onDelete,
  deleting,
}: {
  user: User;
  isSelf: boolean;
  onUpdate: (patch: UpdateUserPayload) => void;
  updating: boolean;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [fullName, setFullName] = useState(user.full_name);
  useEffect(() => setFullName(user.full_name), [user.full_name]);
  const [pendingDelete, setPendingDelete] = useState(false);

  return (
    <Card>
      <CardHead
        title="Manage this person"
        right={
          user.is_active ? <Badge tone="good">Active</Badge> : <Badge tone="critical">Disabled</Badge>
        }
      />

      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Full name">
            {(p) => <Input {...p} value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} />}
          </Field>
          <Button
            size="sm"
            variant="ghost"
            disabled={!fullName.trim() || fullName === user.full_name}
            loading={updating}
            onClick={() => onUpdate({ full_name: fullName.trim() })}
          >
            Save name
          </Button>
        </div>

        <Field label="Role" hint={ROLES.find((r) => r.value === user.role)?.blurb}>
          {(p) => (
            <Select
              {...p}
              value={user.role}
              disabled={isSelf}
              onChange={(e) => onUpdate({ role: e.target.value as Role })}
              className="max-w-xs"
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={isSelf}
            loading={updating}
            onClick={() => onUpdate({ is_active: !user.is_active })}
          >
            {user.is_active ? "Disable account" : "Enable account"}
          </Button>
          <Button size="sm" variant="subtle" disabled={isSelf} onClick={() => setPendingDelete(true)}>
            Delete user
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete}
        title={`Delete ${user.email}?`}
        body="Their account and sign-in are removed permanently. Usage data already collected is kept."
        confirmLabel="Delete user"
        destructive
        busy={deleting}
        onConfirm={onDelete}
        onCancel={() => setPendingDelete(false)}
      />
    </Card>
  );
}
