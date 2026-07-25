/**
 * Agent authentication — per-PC API keys.
 *
 * Keys are random tokens prefixed `cfk_`. Only their sha256 hash is stored, so
 * a leaked database never reveals a usable key. This credential is completely
 * separate from user JWTs: a user token presented here fails the hash lookup and
 * is rejected, which is exactly the intended behaviour.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import { apiKeys, systems, type SystemRow } from "../db/schema.js";
import { unauthorized } from "./errors.js";

const KEY_PREFIX = "cfk_";

export function hashApiKey(fullKey: string): string {
  return createHash("sha256").update(fullKey).digest("hex");
}

/** Generate a new agent key. The full key is shown to the operator exactly once. */
export function generateApiKey(): { fullKey: string; prefix: string; keyHash: string } {
  const secret = randomBytes(32).toString("base64url");
  const fullKey = `${KEY_PREFIX}${secret}`;
  return { fullKey, prefix: fullKey.slice(0, 12), keyHash: hashApiKey(fullKey) };
}

/** Constant-time comparison, so key verification can't be timed. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Authenticate an agent by its bearer key and return the System it belongs to.
 * Revoked keys are rejected. Updates `lastUsedAt` as a side effect.
 */
export async function authenticateAgent(
  authorization: string | undefined,
  conn: DbLike = db,
): Promise<SystemRow> {
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    throw unauthorized("Invalid agent API key");
  }
  const fullKey = authorization.slice(7).trim();
  if (!fullKey.startsWith(KEY_PREFIX)) throw unauthorized("Invalid agent API key");

  const keyHash = hashApiKey(fullKey);
  const rows = await conn
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  const key = rows[0];
  if (!key || key.revokedAt !== null) throw unauthorized("Invalid agent API key");

  const systemRows = await conn
    .select()
    .from(systems)
    .where(eq(systems.systemId, key.systemId))
    .limit(1);

  const system = systemRows[0];
  if (!system) throw unauthorized("Invalid agent API key");

  await conn
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id));

  return system;
}
