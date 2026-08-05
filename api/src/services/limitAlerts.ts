/**
 * Turning a rate-limit crossing into something a person sees.
 *
 * The decision of *whether* to alert lives in core/limitAlerts.ts and is pure;
 * this module only handles delivery — who hears about it and through what.
 *
 * Delivery is an in-app notification, which the bell polls for. There is no
 * push from here: the WebSocket hub runs as its own process (api/src/ws) and
 * the API is a serverless function with no handle on it, so claiming a socket
 * push would be a lie. Worst case a warning is seen one poll interval late.
 */

import {
  alertBody,
  alertTitle,
  alertsForReading,
  type LimitReading,
} from "../core/limitAlerts.js";
import { alertRecipients } from "../repositories/accounts.js";
import { createNotification } from "../repositories/notifications.js";

export async function raiseLimitAlerts(input: {
  accountId: number;
  accountLabel: string;
  readings: LimitReading[];
  previousPercents: Map<string, number>;
}): Promise<number> {
  const alerts = alertsForReading(input.readings, input.previousPercents);
  if (alerts.length === 0) return 0;

  const recipients = await alertRecipients(input.accountId);
  if (recipients.length === 0) return 0;

  for (const alert of alerts) {
    for (const userId of recipients) {
      await createNotification({
        userId,
        type: alert.level === "error" ? "account.limit_critical" : "account.limit_warning",
        title: alertTitle(alert),
        body: alertBody(alert, input.accountLabel),
        entityType: "claude_account",
        entityId: input.accountId,
        link: "/accounts",
      });
    }
  }

  return alerts.length;
}
