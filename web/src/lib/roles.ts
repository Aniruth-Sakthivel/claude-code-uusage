import type { Role } from "../api/types";

export const ROLES: { value: Role; label: string; blurb: string }[] = [
  { value: "admin", label: "Administrator", blurb: "Full access, including users and keys." },
  { value: "manager", label: "Manager", blurb: "Sees every PC and all analytics." },
  { value: "developer", label: "Developer", blurb: "Sees only the PCs you assign." },
  { value: "viewer", label: "Viewer", blurb: "Read-only across every PC." },
  { value: "client", label: "Client", blurb: "External portal only — sees just the initiatives shared with them." },
];
