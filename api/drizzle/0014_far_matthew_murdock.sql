ALTER TABLE "systems" ADD COLUMN "agent_status" varchar(16) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "systems" ADD COLUMN "agent_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "systems" ADD COLUMN "agent_status_detail" varchar(255) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "systems" ADD COLUMN "scan_interval_seconds" integer;--> statement-breakpoint
ALTER TABLE "systems" ADD COLUMN "last_scan_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "systems" ADD COLUMN "last_scan_duration_ms" integer;