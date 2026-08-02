/**
 * Data access for the internal PM module: initiatives, milestones, tasks,
 * task comments, docs, and the activity feed.
 *
 * One file for all six tables — they're small and tightly related (unlike
 * admin.ts, which spans several unrelated concerns). Split if it grows
 * unwieldy.
 */

import { and, desc, eq, ilike, isNotNull, isNull, sql } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import {
  channels,
  docs,
  initiativeClients,
  initiatives,
  milestones,
  pmActivity,
  taskComments,
  tasks,
  users,
  type DocRow,
  type InitiativeRow,
  type MilestoneRow,
  type PmActivityRow,
  type TaskCommentRow,
  type TaskRow,
} from "../db/schema.js";

// ── initiatives ───────────────────────────────────────────────────────────────
export interface InitiativeCreateInput {
  name: string;
  description: string;
}

export async function createInitiative(
  input: InitiativeCreateInput,
  createdByUserId: number | null,
  conn: DbLike = db,
): Promise<InitiativeRow> {
  const rows = await conn
    .insert(initiatives)
    .values({ name: input.name, description: input.description, createdByUserId })
    .returning();
  return rows[0]!;
}

export interface InitiativeWithCounts extends InitiativeRow {
  taskCount: number;
  openTaskCount: number;
}

/** Task counts merged in separately, same pattern as `listUsers` merging
 * `userSystems` in repositories/admin.ts — avoids a fan-out join. */
export async function listInitiatives(conn: DbLike = db): Promise<InitiativeWithCounts[]> {
  const rows = await conn.select().from(initiatives).orderBy(desc(initiatives.createdAt));
  if (rows.length === 0) return [];

  const counts = await conn
    .select({
      initiativeId: tasks.initiativeId,
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${tasks.status} != 'done')::int`,
    })
    .from(tasks)
    .groupBy(tasks.initiativeId);

  const byId = new Map(counts.map((c) => [c.initiativeId, c]));
  return rows.map((r) => ({
    ...r,
    taskCount: byId.get(r.id)?.total ?? 0,
    openTaskCount: byId.get(r.id)?.open ?? 0,
  }));
}

/** Client-portal variant of `listInitiatives`, scoped to an explicit id set
 * (the caller's shared initiatives) rather than every initiative. */
export async function listInitiativesByIds(
  ids: number[],
  conn: DbLike = db,
): Promise<InitiativeWithCounts[]> {
  if (ids.length === 0) return [];
  const rows = await conn
    .select()
    .from(initiatives)
    .where(sql`${initiatives.id} = any(${ids})`)
    .orderBy(desc(initiatives.createdAt));
  if (rows.length === 0) return [];

  const counts = await conn
    .select({
      initiativeId: tasks.initiativeId,
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${tasks.status} != 'done')::int`,
    })
    .from(tasks)
    .where(sql`${tasks.initiativeId} = any(${ids})`)
    .groupBy(tasks.initiativeId);

  const byId = new Map(counts.map((c) => [c.initiativeId, c]));
  return rows.map((r) => ({
    ...r,
    taskCount: byId.get(r.id)?.total ?? 0,
    openTaskCount: byId.get(r.id)?.open ?? 0,
  }));
}

export async function getInitiative(id: number, conn: DbLike = db): Promise<InitiativeRow | null> {
  const rows = await conn.select().from(initiatives).where(eq(initiatives.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function initiativeExists(id: number, conn: DbLike = db): Promise<boolean> {
  const rows = await conn
    .select({ id: initiatives.id })
    .from(initiatives)
    .where(eq(initiatives.id, id))
    .limit(1);
  return rows.length > 0;
}

export interface InitiativeUpdateInput {
  name?: string;
  description?: string;
  status?: string;
}

export async function updateInitiative(
  id: number,
  patch: InitiativeUpdateInput,
  conn: DbLike = db,
): Promise<InitiativeRow | null> {
  const rows = await conn
    .update(initiatives)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(initiatives.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteInitiative(id: number, conn: DbLike = db): Promise<void> {
  await conn.delete(initiatives).where(eq(initiatives.id, id));
}

// ── milestones ───────────────────────────────────────────────────────────────
export interface MilestoneCreateInput {
  name: string;
  dueDate: string | null;
}

export async function createMilestone(
  initiativeId: number,
  input: MilestoneCreateInput,
  createdByUserId: number | null,
  conn: DbLike = db,
): Promise<MilestoneRow> {
  const rows = await conn
    .insert(milestones)
    .values({ initiativeId, name: input.name, dueDate: input.dueDate, createdByUserId })
    .returning();
  return rows[0]!;
}

export async function listMilestones(initiativeId: number, conn: DbLike = db): Promise<MilestoneRow[]> {
  return conn
    .select()
    .from(milestones)
    .where(eq(milestones.initiativeId, initiativeId))
    .orderBy(milestones.dueDate);
}

export async function getMilestone(id: number, conn: DbLike = db): Promise<MilestoneRow | null> {
  const rows = await conn.select().from(milestones).where(eq(milestones.id, id)).limit(1);
  return rows[0] ?? null;
}

export interface MilestoneUpdateInput {
  name?: string;
  dueDate?: string | null;
  status?: string;
}

export async function updateMilestone(
  id: number,
  patch: MilestoneUpdateInput,
  conn: DbLike = db,
): Promise<MilestoneRow | null> {
  const rows = await conn.update(milestones).set(patch).where(eq(milestones.id, id)).returning();
  return rows[0] ?? null;
}

export async function deleteMilestone(id: number, conn: DbLike = db): Promise<void> {
  await conn.delete(milestones).where(eq(milestones.id, id));
}

// ── tasks ────────────────────────────────────────────────────────────────────
export interface TaskCreateInput {
  title: string;
  description: string;
  milestoneId: number | null;
  assigneeUserId: number | null;
  dueDate: string | null;
  epicId?: number | null;
  sprintId?: number | null;
  parentTaskId?: number | null;
  priority?: string;
  storyPoints?: number | null;
  status?: string; // defaults to the initiative's first column if omitted — see services/pm.ts
}

export async function createTask(
  initiativeId: number,
  input: TaskCreateInput,
  createdByUserId: number | null,
  conn: DbLike = db,
): Promise<TaskRow> {
  const rows = await conn
    .insert(tasks)
    .values({
      initiativeId,
      title: input.title,
      description: input.description,
      milestoneId: input.milestoneId,
      assigneeUserId: input.assigneeUserId,
      dueDate: input.dueDate,
      epicId: input.epicId ?? null,
      sprintId: input.sprintId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      priority: input.priority ?? "medium",
      storyPoints: input.storyPoints ?? null,
      ...(input.status ? { status: input.status } : {}),
      createdByUserId,
    })
    .returning();
  return rows[0]!;
}

export interface TaskWithCommentCount extends TaskRow {
  commentCount: number;
}

/** All tasks for an initiative — the board view groups by `status` client-side. */
export async function listTasks(initiativeId: number, conn: DbLike = db): Promise<TaskWithCommentCount[]> {
  const rows = await conn
    .select()
    .from(tasks)
    .where(eq(tasks.initiativeId, initiativeId))
    .orderBy(tasks.createdAt);
  if (rows.length === 0) return [];

  const counts = await conn
    .select({ taskId: taskComments.taskId, n: sql<number>`count(*)::int` })
    .from(taskComments)
    .where(sql`${taskComments.taskId} = any(${rows.map((r) => r.id)})`)
    .groupBy(taskComments.taskId);

  const byId = new Map(counts.map((c) => [c.taskId, c.n]));
  return rows.map((r) => ({ ...r, commentCount: byId.get(r.id) ?? 0 }));
}

export async function getTask(id: number, conn: DbLike = db): Promise<TaskRow | null> {
  const rows = await conn.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listSubtasks(parentTaskId: number, conn: DbLike = db): Promise<TaskRow[]> {
  return conn.select().from(tasks).where(eq(tasks.parentTaskId, parentTaskId)).orderBy(tasks.createdAt);
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: string;
  milestoneId?: number | null;
  assigneeUserId?: number | null;
  dueDate?: string | null;
  epicId?: number | null;
  sprintId?: number | null;
  parentTaskId?: number | null;
  priority?: string;
  storyPoints?: number | null;
}

export async function updateTask(
  id: number,
  patch: TaskUpdateInput,
  conn: DbLike = db,
): Promise<TaskRow | null> {
  const rows = await conn
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteTask(id: number, conn: DbLike = db): Promise<void> {
  await conn.delete(tasks).where(eq(tasks.id, id));
}

// ── task comments ────────────────────────────────────────────────────────────
export async function createComment(
  taskId: number,
  body: string,
  authorUserId: number | null,
  authorEmail: string,
  conn: DbLike = db,
): Promise<TaskCommentRow> {
  const rows = await conn
    .insert(taskComments)
    .values({ taskId, body, authorUserId, authorEmail })
    .returning();
  return rows[0]!;
}

export async function listComments(taskId: number, conn: DbLike = db): Promise<TaskCommentRow[]> {
  return conn
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(taskComments.createdAt);
}

// ── docs ─────────────────────────────────────────────────────────────────────
export interface DocCreateInput {
  title: string;
  body: string;
}

/** `initiativeId: null` creates a workspace-wide wiki page instead of a
 * per-initiative doc — see the schema.ts comment on `docs.initiativeId`. */
export async function createDoc(
  initiativeId: number | null,
  input: DocCreateInput,
  createdByUserId: number | null,
  conn: DbLike = db,
): Promise<DocRow> {
  const rows = await conn
    .insert(docs)
    .values({
      initiativeId,
      title: input.title,
      body: input.body,
      createdByUserId,
      updatedByUserId: createdByUserId,
    })
    .returning();
  return rows[0]!;
}

export async function listDocs(initiativeId: number, conn: DbLike = db): Promise<DocRow[]> {
  return conn.select().from(docs).where(eq(docs.initiativeId, initiativeId)).orderBy(docs.title);
}

export async function listWorkspaceDocs(conn: DbLike = db): Promise<DocRow[]> {
  return conn.select().from(docs).where(isNull(docs.initiativeId)).orderBy(docs.title);
}

export async function getDoc(id: number, conn: DbLike = db): Promise<DocRow | null> {
  const rows = await conn.select().from(docs).where(eq(docs.id, id)).limit(1);
  return rows[0] ?? null;
}

export interface DocUpdateInput {
  title?: string;
  body?: string;
}

export async function updateDoc(
  id: number,
  patch: DocUpdateInput,
  updatedByUserId: number | null,
  conn: DbLike = db,
): Promise<DocRow | null> {
  const rows = await conn
    .update(docs)
    .set({ ...patch, updatedByUserId, updatedAt: new Date() })
    .where(eq(docs.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteDoc(id: number, conn: DbLike = db): Promise<void> {
  await conn.delete(docs).where(eq(docs.id, id));
}

// ── reports/analytics (workspace-wide) ──────────────────────────────────────
export interface ReportsSummary {
  initiativesByStatus: { status: string; n: number }[];
  tasksByStatus: { status: string; n: number }[];
  workload: { userId: number; email: string; fullName: string; n: number }[];
  completedByDay: { day: string; n: number }[];
}

export async function getReportsSummary(conn: DbLike = db): Promise<ReportsSummary> {
  const [initiativesByStatus, tasksByStatus, workload, completedByDay] = await Promise.all([
    conn
      .select({ status: initiatives.status, n: sql<number>`count(*)::int` })
      .from(initiatives)
      .groupBy(initiatives.status),
    conn
      .select({ status: tasks.status, n: sql<number>`count(*)::int` })
      .from(tasks)
      .groupBy(tasks.status),
    // Open (not-done) work per assignee — what "reports/analytics" workload
    // views usually mean: who is currently carrying how much.
    conn
      .select({
        userId: tasks.assigneeUserId,
        email: users.email,
        fullName: users.fullName,
        n: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .innerJoin(users, eq(users.id, tasks.assigneeUserId))
      .where(and(isNotNull(tasks.assigneeUserId), sql`${tasks.status} != 'done'`))
      .groupBy(tasks.assigneeUserId, users.email, users.fullName)
      .orderBy(desc(sql`count(*)`))
      .limit(10),
    // Approximate: `updatedAt` on a `done` task, not a dedicated completion
    // timestamp — good enough for a trend line, not exact to the second.
    conn
      .select({
        day: sql<string>`to_char(${tasks.updatedAt}, 'YYYY-MM-DD')`,
        n: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(and(eq(tasks.status, "done"), sql`${tasks.updatedAt} >= now() - interval '13 days'`))
      .groupBy(sql`to_char(${tasks.updatedAt}, 'YYYY-MM-DD')`),
  ]);

  return {
    initiativesByStatus,
    tasksByStatus,
    workload: workload.map((w) => ({ ...w, userId: w.userId! })),
    completedByDay,
  };
}

// ── client portal (initiative sharing) ──────────────────────────────────────
export async function shareInitiativeWithClient(
  initiativeId: number,
  userId: number,
  conn: DbLike = db,
): Promise<void> {
  await conn.insert(initiativeClients).values({ initiativeId, userId }).onConflictDoNothing();
}

export async function unshareInitiativeFromClient(
  initiativeId: number,
  userId: number,
  conn: DbLike = db,
): Promise<void> {
  await conn
    .delete(initiativeClients)
    .where(and(eq(initiativeClients.initiativeId, initiativeId), eq(initiativeClients.userId, userId)));
}

export async function listSharedInitiativeIds(userId: number, conn: DbLike = db): Promise<number[]> {
  const rows = await conn
    .select({ initiativeId: initiativeClients.initiativeId })
    .from(initiativeClients)
    .where(eq(initiativeClients.userId, userId));
  return rows.map((r) => r.initiativeId);
}

export async function isSharedWithClient(
  initiativeId: number,
  userId: number,
  conn: DbLike = db,
): Promise<boolean> {
  const rows = await conn
    .select({ userId: initiativeClients.userId })
    .from(initiativeClients)
    .where(and(eq(initiativeClients.initiativeId, initiativeId), eq(initiativeClients.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

export interface ClientRef {
  userId: number;
  email: string;
  fullName: string;
}

export async function listClientsForInitiative(initiativeId: number, conn: DbLike = db): Promise<ClientRef[]> {
  const rows = await conn
    .select({ userId: users.id, email: users.email, fullName: users.fullName })
    .from(initiativeClients)
    .innerJoin(users, eq(users.id, initiativeClients.userId))
    .where(eq(initiativeClients.initiativeId, initiativeId));
  return rows;
}

// ── global search ────────────────────────────────────────────────────────────
export interface SearchResult {
  kind: "initiative" | "task" | "doc" | "channel";
  id: number;
  title: string;
  subtitle: string;
  link: string;
}

/**
 * Simple `ILIKE` search across the Workspace domain (initiatives/tasks/docs/
 * channels) — no dedicated search engine (Meilisearch etc.) yet, per the
 * "hold off on new infra" decision. Fine at this data scale; revisit if the
 * table sizes ever justify a real search index.
 */
export async function search(query: string, limitPerKind = 5, conn: DbLike = db): Promise<SearchResult[]> {
  const like = `%${query}%`;

  const [initiativeRows, taskRows, docRows, channelRows] = await Promise.all([
    conn.select().from(initiatives).where(ilike(initiatives.name, like)).limit(limitPerKind),
    conn
      .select({ id: tasks.id, title: tasks.title, initiativeId: tasks.initiativeId, initiativeName: initiatives.name })
      .from(tasks)
      .innerJoin(initiatives, eq(initiatives.id, tasks.initiativeId))
      .where(ilike(tasks.title, like))
      .limit(limitPerKind),
    conn
      .select({ id: docs.id, title: docs.title, initiativeId: docs.initiativeId, initiativeName: initiatives.name })
      .from(docs)
      .innerJoin(initiatives, eq(initiatives.id, docs.initiativeId))
      .where(ilike(docs.title, like))
      .limit(limitPerKind),
    conn.select().from(channels).where(ilike(channels.name, like)).limit(limitPerKind),
  ]);

  return [
    ...initiativeRows.map((r) => ({
      kind: "initiative" as const,
      id: r.id,
      title: r.name,
      subtitle: "Initiative",
      link: `/workspace/initiatives/${r.id}`,
    })),
    ...taskRows.map((r) => ({
      kind: "task" as const,
      id: r.id,
      title: r.title,
      subtitle: `Task in ${r.initiativeName}`,
      link: `/workspace/initiatives/${r.initiativeId}`,
    })),
    ...docRows.map((r) => ({
      kind: "doc" as const,
      id: r.id,
      title: r.title,
      subtitle: `Doc in ${r.initiativeName}`,
      link: `/workspace/initiatives/${r.initiativeId}`,
    })),
    ...channelRows.map((r) => ({
      kind: "channel" as const,
      id: r.id,
      title: r.name || "Channel",
      subtitle: "Channel",
      link: `/workspace/chat`,
    })),
  ];
}

// ── calendar (workspace-wide) ───────────────────────────────────────────────
export interface CalendarTaskItem {
  kind: "task";
  id: number;
  initiativeId: number;
  initiativeName: string;
  title: string;
  dueDate: string;
  status: string;
}

export interface CalendarMilestoneItem {
  kind: "milestone";
  id: number;
  initiativeId: number;
  initiativeName: string;
  title: string;
  dueDate: string;
  status: string;
}

/** Every task with a due date, across every initiative — PM is open to every
 * user, so there's no per-user scoping to apply here (unlike the fleet's
 * `visibleSystemIds`). */
export async function listCalendarTasks(conn: DbLike = db): Promise<CalendarTaskItem[]> {
  const rows = await conn
    .select({
      id: tasks.id,
      initiativeId: tasks.initiativeId,
      initiativeName: initiatives.name,
      title: tasks.title,
      dueDate: tasks.dueDate,
      status: tasks.status,
    })
    .from(tasks)
    .innerJoin(initiatives, eq(initiatives.id, tasks.initiativeId))
    .where(isNotNull(tasks.dueDate));
  return rows.map((r) => ({ kind: "task" as const, ...r, dueDate: r.dueDate! }));
}

export async function listCalendarMilestones(conn: DbLike = db): Promise<CalendarMilestoneItem[]> {
  const rows = await conn
    .select({
      id: milestones.id,
      initiativeId: milestones.initiativeId,
      initiativeName: initiatives.name,
      title: milestones.name,
      dueDate: milestones.dueDate,
      status: milestones.status,
    })
    .from(milestones)
    .innerJoin(initiatives, eq(initiatives.id, milestones.initiativeId))
    .where(isNotNull(milestones.dueDate));
  return rows.map((r) => ({ kind: "milestone" as const, ...r, dueDate: r.dueDate! }));
}

// ── activity feed ────────────────────────────────────────────────────────────
export interface ActivityInput {
  initiativeId: number;
  actorUserId: number | null;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: number;
  detail?: string;
}

export async function writeActivity(entry: ActivityInput, conn: DbLike = db): Promise<void> {
  await conn.insert(pmActivity).values({
    initiativeId: entry.initiativeId,
    actorUserId: entry.actorUserId,
    actorEmail: entry.actorEmail,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    detail: entry.detail ?? "",
  });
}

export async function listActivity(
  initiativeId: number,
  limit = 100,
  conn: DbLike = db,
): Promise<PmActivityRow[]> {
  return conn
    .select()
    .from(pmActivity)
    .where(eq(pmActivity.initiativeId, initiativeId))
    .orderBy(desc(pmActivity.at))
    .limit(limit);
}
