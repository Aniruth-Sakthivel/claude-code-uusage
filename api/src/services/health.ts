/**
 * Agent diagnostics (full health snapshot).
 *
 * Read-only from the dashboard's side and not audited — same reasoning as
 * commands.ts's "handing pending commands... is plumbing, not audited
 * events": nobody is acting on anything here, just looking at what the
 * agent last reported about itself.
 */

import { notFound } from "../core/errors.js";
import * as adminRepo from "../repositories/admin.js";
import * as healthRepo from "../repositories/health.js";
import type { HealthSnapshotInput } from "../repositories/health.js";

export async function reportHealth(systemId: string, data: HealthSnapshotInput): Promise<void> {
  await healthRepo.upsertHealthSnapshot(systemId, data);
}

export async function getSystemHealth(systemId: string) {
  if (!(await adminRepo.systemExists(systemId))) throw notFound("System not found");
  return healthRepo.getHealthSnapshot(systemId);
}
