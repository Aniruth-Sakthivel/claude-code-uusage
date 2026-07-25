CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"system_id" varchar(64) NOT NULL,
	"name" varchar(120) DEFAULT '' NOT NULL,
	"prefix" varchar(16) NOT NULL,
	"key_hash" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"actor_user_id" integer,
	"actor_email" varchar(255) DEFAULT '' NOT NULL,
	"action" varchar(64) NOT NULL,
	"target" varchar(255) DEFAULT '' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"ip" varchar(64) DEFAULT '' NOT NULL,
	"user_agent" varchar(255) DEFAULT '' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_aggregates" (
	"system_id" varchar(64) NOT NULL,
	"day" varchar(10) NOT NULL,
	"model_family" varchar(24) DEFAULT 'unknown' NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_aggregates_system_id_day_model_family_pk" PRIMARY KEY("system_id","day","model_family")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enroll_tokens" (
	"token" varchar(64) PRIMARY KEY NOT NULL,
	"system_id" varchar(64) NOT NULL,
	"api_key_id" integer NOT NULL,
	"api_key_plain" varchar(128) NOT NULL,
	"created_by_user_id" integer,
	"display_name" varchar(120) DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(32) NOT NULL,
	"description" varchar(200) DEFAULT '' NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_logs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"system_id" varchar(64) NOT NULL,
	"received" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "systems" (
	"system_id" varchar(64) PRIMARY KEY NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"hostname" varchar(255) DEFAULT '' NOT NULL,
	"agent_version" varchar(32) DEFAULT '' NOT NULL,
	"owner" varchar(120) DEFAULT '' NOT NULL,
	"location" varchar(120) DEFAULT '' NOT NULL,
	"environment" varchar(40) DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_user_id" integer,
	"last_seen_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"total_events" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_events" (
	"event_id" varchar(128) PRIMARY KEY NOT NULL,
	"system_id" varchar(64) NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"project_name" varchar(255) DEFAULT 'unknown' NOT NULL,
	"ts_utc" varchar(40) NOT NULL,
	"day" varchar(10) NOT NULL,
	"model" varchar(80) DEFAULT '' NOT NULL,
	"model_family" varchar(24) DEFAULT 'unknown' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"tool_name" varchar(80),
	"is_subagent" integer DEFAULT 0 NOT NULL,
	"agent_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_systems" (
	"user_id" integer NOT NULL,
	"system_id" varchar(64) NOT NULL,
	CONSTRAINT "user_systems_user_id_system_id_pk" PRIMARY KEY("user_id","system_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email" varchar(255) NOT NULL,
	"full_name" varchar(120) DEFAULT '' NOT NULL,
	"supabase_user_id" varchar(64),
	"role_id" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_supabase_user_id_unique" UNIQUE("supabase_user_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_system_id_systems_system_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("system_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_aggregates" ADD CONSTRAINT "daily_aggregates_system_id_systems_system_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("system_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enroll_tokens" ADD CONSTRAINT "enroll_tokens_system_id_systems_system_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("system_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enroll_tokens" ADD CONSTRAINT "enroll_tokens_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enroll_tokens" ADD CONSTRAINT "enroll_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "systems" ADD CONSTRAINT "systems_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_system_id_systems_system_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("system_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_systems" ADD CONSTRAINT "user_systems_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_systems" ADD CONSTRAINT "user_systems_system_id_systems_system_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("system_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_system_idx" ON "api_keys" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_at_idx" ON "audit_logs" USING btree ("at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_aggregates_day_idx" ON "daily_aggregates" USING btree ("day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enroll_tokens_expires_idx" ON "enroll_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_logs_system_at_idx" ON "sync_logs" USING btree ("system_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "systems_created_by_idx" ON "systems" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_system_day_idx" ON "usage_events" USING btree ("system_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_system_day_tokens_idx" ON "usage_events" USING btree ("system_id","day","total_tokens");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_day_idx" ON "usage_events" USING btree ("day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_project_idx" ON "usage_events" USING btree ("system_id","project_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_session_idx" ON "usage_events" USING btree ("system_id","session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_systems_system_idx" ON "user_systems" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_supabase_uid_idx" ON "users" USING btree ("supabase_user_id");