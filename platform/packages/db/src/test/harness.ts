/**
 * Test harness — real Postgres, in process, no container.
 *
 * PGlite is Postgres compiled to WASM, so the poison-row suite runs against
 * genuine Postgres semantics (partial indexes, `inArray` behaviour, NULL
 * handling) rather than a mock that would agree with whatever we assumed.
 * Docker is not available in every environment this must run in, and a tenancy
 * suite that gets skipped is a tenancy suite that does not exist.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";

import { __unsafeCreateRequestContext, uuidv7, type Role } from "@platform/core";

import * as schema from "../schema/tenancy.js";
import type { Db } from "../client.js";

const DDL = `
create table organizations (
  id uuid primary key,
  name varchar(200) not null,
  created_at timestamptz not null default now()
);

create table workspaces (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  slug varchar(64) not null,
  name varchar(200) not null,
  accent_color varchar(16) not null default '',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index workspaces_slug_idx on workspaces (slug) where deleted_at is null;

create table users (
  id uuid primary key,
  supabase_user_id uuid unique,
  email varchar(255) not null unique,
  full_name varchar(200) not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role varchar(32) not null,
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table projects (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key varchar(12) not null,
  name varchar(200) not null,
  lead_user_id uuid references users(id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz
);
create unique index projects_key_idx on projects (workspace_id, key) where deleted_at is null;

create table project_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table issues (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  key varchar(24) not null,
  type varchar(16) not null default 'task',
  title varchar(300) not null,
  status varchar(32) not null default 'todo',
  priority varchar(16) not null default 'medium',
  assignee_user_id uuid references users(id) on delete set null,
  rank varchar(64) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz
);
create unique index issues_key_idx on issues (workspace_id, key) where deleted_at is null;
create index issues_board_idx on issues (workspace_id, project_id, status, rank);
`;

export interface Seeded {
  db: Db;
  close: () => Promise<void>;
  organizationId: string;
  /** Two fully-populated workspaces. Every assertion is "A must never see B". */
  A: SeededWorkspace;
  B: SeededWorkspace;
}

export interface SeededWorkspace {
  workspaceId: string;
  slug: string;
  userId: string;
  projectId: string;
  issueId: string;
  /** Row ids present in this workspace, by table. Used to detect leakage. */
  rowIds: Record<string, string[]>;
}

export async function seed(): Promise<Seeded> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;

  for (const statement of DDL.split(";\n").map((s) => s.trim()).filter(Boolean)) {
    await db.execute(sql.raw(statement));
  }

  const organizationId = uuidv7();
  await db.insert(schema.organizations).values({ id: organizationId, name: "Acme" });

  const A = await seedWorkspace(db, organizationId, "alpha");
  const B = await seedWorkspace(db, organizationId, "bravo");

  return {
    db,
    close: () => client.close(),
    organizationId,
    A,
    B,
  };
}

async function seedWorkspace(
  db: Db,
  organizationId: string,
  slug: string,
): Promise<SeededWorkspace> {
  const workspaceId = uuidv7();
  const userId = uuidv7();
  const projectId = uuidv7();
  const issueId = uuidv7();

  await db
    .insert(schema.workspaces)
    .values({ id: workspaceId, organizationId, slug, name: slug });

  await db
    .insert(schema.users)
    .values({ id: userId, email: `${slug}@example.test`, fullName: `${slug} user` });

  await db
    .insert(schema.workspaceMembers)
    .values({ workspaceId, userId, role: "admin" });

  await db
    .insert(schema.projects)
    .values({ id: projectId, workspaceId, key: slug.slice(0, 3).toUpperCase(), name: `${slug} project` });

  await db
    .insert(schema.projectMembers)
    .values({ workspaceId, projectId, userId });

  await db.insert(schema.issues).values({
    id: issueId,
    workspaceId,
    projectId,
    key: `${slug.slice(0, 3).toUpperCase()}-1`,
    title: `${slug} issue`,
    rank: "0|hzzzzz:",
  });

  return {
    workspaceId,
    slug,
    userId,
    projectId,
    issueId,
    rowIds: {
      workspaces: [workspaceId],
      users: [userId],
      projects: [projectId],
      issues: [issueId],
      workspace_members: [userId],
      project_members: [projectId],
    },
  };
}

/** A principal scoped to one workspace, for driving repository calls. */
export function principalFor(
  ws: SeededWorkspace,
  role: Role = "admin",
): ReturnType<typeof __unsafeCreateRequestContext> {
  return __unsafeCreateRequestContext({
    userId: ws.userId,
    role,
    workspaceId: ws.workspaceId,
    projectIds: [ws.projectId],
  });
}
