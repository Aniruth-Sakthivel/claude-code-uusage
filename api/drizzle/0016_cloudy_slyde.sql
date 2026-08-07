CREATE TABLE "agent_health_snapshots" (
	"system_id" varchar(64) PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"last_scan_at" timestamp with time zone,
	"last_scan_duration_ms" integer,
	"last_scan_error" text DEFAULT '' NOT NULL,
	"scans_completed" integer DEFAULT 0 NOT NULL,
	"scans_failed" integer DEFAULT 0 NOT NULL,
	"ws_connected" boolean DEFAULT false NOT NULL,
	"ws_last_connected_at" timestamp with time zone,
	"ws_last_disconnect_reason" text DEFAULT '' NOT NULL,
	"ws_reconnect_attempts" integer DEFAULT 0 NOT NULL,
	"offline_queue_depth" integer DEFAULT 0 NOT NULL,
	"active_sessions" integer DEFAULT 0 NOT NULL,
	"pid" integer,
	"validation_issues" text DEFAULT '[]' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_health_snapshots" ADD CONSTRAINT "agent_health_snapshots_system_id_systems_system_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("system_id") ON DELETE cascade ON UPDATE no action;