/**
 * Usage ingest — the write path for agent sync.
 *
 * The dedup guarantee: `event_id = "<system_id>:<suffix>"` is the primary key,
 * so re-sending an event is a no-op at the database level.
 *
 * This replaces the Python implementation, which SELECTed existing ids and then
 * inserted the difference row by row. That had two problems: it issued one
 * INSERT per event, and two concurrent syncs from the same machine could both
 * pass the existence check and race. A single `ON CONFLICT DO NOTHING` is one
 * round trip and is atomic by construction.
 */

import { eq, sql } from "drizzle-orm";

import type { DbLike } from "../db/client.js";
import { db } from "../db/client.js";
import {
  dailyAggregates,
  syncLogs,
  systems,
  usageEvents,
  type NewUsageEvent,
} from "../db/schema.js";

export interface IncomingEvent {
  suffix: string;
  sessionId: string;
  projectName: string;
  tsUtc: string;
  day: string;
  model: string;
  modelFamily: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  toolName: string | null;
  isSubagent: number;
  agentId: string | null;
}

export interface IngestResult {
  received: number;
  inserted: number;
  duplicates: number;
  failed: number;
}

/**
 * Insert a batch idempotently and keep the rollup in step.
 *
 * Everything happens in one transaction: events, daily aggregate upsert, system
 * counters, and the sync log. Either the whole batch lands or none of it does,
 * so `daily_aggregates` can never drift from `usage_events`.
 */
export async function ingestEvents(
  systemId: string,
  events: IncomingEvent[],
  conn: DbLike = db,
): Promise<IngestResult> {
  if (events.length === 0) {
    return { received: 0, inserted: 0, duplicates: 0, failed: 0 };
  }

  // De-duplicate within the batch itself: ON CONFLICT cannot resolve two rows
  // with the same key in a single statement ("cannot affect row a second time").
  const byId = new Map<string, NewUsageEvent>();
  for (const e of events) {
    const eventId = `${systemId}:${e.suffix}`;
    byId.set(eventId, {
      eventId,
      systemId,
      sessionId: e.sessionId,
      projectName: e.projectName,
      tsUtc: e.tsUtc,
      day: e.day,
      model: e.model,
      modelFamily: e.modelFamily,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheCreationTokens: e.cacheCreationTokens,
      totalTokens: e.totalTokens,
      toolName: e.toolName,
      isSubagent: e.isSubagent,
      agentId: e.agentId,
    });
  }
  const rows = [...byId.values()];

  const runner = async (tx: DbLike) => {
    const insertedRows = await tx
      .insert(usageEvents)
      .values(rows)
      .onConflictDoNothing({ target: usageEvents.eventId })
      .returning({ eventId: usageEvents.eventId });

    const insertedIds = new Set(insertedRows.map((r) => r.eventId));
    const inserted = insertedIds.size;
    const duplicates = events.length - inserted;

    // Roll up ONLY the rows that actually landed — otherwise a retried batch
    // would inflate the aggregates even though the events were deduped.
    if (inserted > 0) {
      const buckets = new Map<
        string,
        {
          systemId: string;
          day: string;
          modelFamily: string;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheCreationTokens: number;
          totalTokens: number;
          eventCount: number;
        }
      >();

      for (const r of rows) {
        if (!insertedIds.has(r.eventId)) continue;
        const family = r.modelFamily ?? "unknown";
        const key = `${r.day}|${family}`;
        const b = buckets.get(key) ?? {
          systemId,
          day: r.day,
          modelFamily: family,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
          eventCount: 0,
        };
        b.inputTokens += r.inputTokens ?? 0;
        b.outputTokens += r.outputTokens ?? 0;
        b.cacheReadTokens += r.cacheReadTokens ?? 0;
        b.cacheCreationTokens += r.cacheCreationTokens ?? 0;
        b.totalTokens += r.totalTokens ?? 0;
        b.eventCount += 1;
        buckets.set(key, b);
      }

      await tx
        .insert(dailyAggregates)
        .values([...buckets.values()])
        .onConflictDoUpdate({
          target: [
            dailyAggregates.systemId,
            dailyAggregates.day,
            dailyAggregates.modelFamily,
          ],
          set: {
            inputTokens: sql`${dailyAggregates.inputTokens} + excluded.input_tokens`,
            outputTokens: sql`${dailyAggregates.outputTokens} + excluded.output_tokens`,
            cacheReadTokens: sql`${dailyAggregates.cacheReadTokens} + excluded.cache_read_tokens`,
            cacheCreationTokens: sql`${dailyAggregates.cacheCreationTokens} + excluded.cache_creation_tokens`,
            totalTokens: sql`${dailyAggregates.totalTokens} + excluded.total_tokens`,
            eventCount: sql`${dailyAggregates.eventCount} + excluded.event_count`,
          },
        });
    }

    const now = new Date();
    await tx
      .update(systems)
      .set({
        lastSeenAt: now,
        lastSyncAt: now,
        totalEvents: sql`${systems.totalEvents} + ${inserted}`,
      })
      .where(eq(systems.systemId, systemId));

    await tx.insert(syncLogs).values({
      systemId,
      received: events.length,
      inserted,
      duplicates,
    });

    return { received: events.length, inserted, duplicates, failed: 0 };
  };

  // Reuse an outer transaction if one was passed (tests), else open our own.
  return "transaction" in conn
    ? await (conn as typeof db).transaction(runner)
    : await runner(conn);
}
