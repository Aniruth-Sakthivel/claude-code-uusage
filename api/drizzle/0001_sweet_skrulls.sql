CREATE TABLE IF NOT EXISTS "account_usage_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_usage_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"system_id" varchar(64) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"grp" varchar(32) DEFAULT '' NOT NULL,
	"scope_label" varchar(80) DEFAULT '' NOT NULL,
	"percent" numeric(6, 2) DEFAULT '0' NOT NULL,
	"severity" varchar(24) DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"resets_at" timestamp with time zone,
	"limit_dollars" numeric(12, 4),
	"used_dollars" numeric(12, 4),
	"remaining_dollars" numeric(12, 4),
	"fetched_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claude_accounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "claude_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_uuid" varchar(64) NOT NULL,
	"email_address" varchar(255) DEFAULT '' NOT NULL,
	"display_name" varchar(120) DEFAULT '' NOT NULL,
	"organization_name" varchar(200) DEFAULT '' NOT NULL,
	"organization_uuid" varchar(64) DEFAULT '' NOT NULL,
	"organization_type" varchar(64) DEFAULT '' NOT NULL,
	"rate_limit_tier" varchar(64) DEFAULT '' NOT NULL,
	"organization_role" varchar(40) DEFAULT '' NOT NULL,
	"billing_type" varchar(40) DEFAULT '' NOT NULL,
	"has_extra_usage_enabled" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_accounts_account_uuid_unique" UNIQUE("account_uuid")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_account_bindings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "system_account_bindings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"system_id" varchar(64) NOT NULL,
	"account_id" integer NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"source" varchar(16) DEFAULT 'agent' NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_usage_snapshots" ADD CONSTRAINT "account_usage_snapshots_account_id_claude_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."claude_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_usage_snapshots" ADD CONSTRAINT "account_usage_snapshots_system_id_systems_system_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("system_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "system_account_bindings" ADD CONSTRAINT "system_account_bindings_system_id_systems_system_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("system_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "system_account_bindings" ADD CONSTRAINT "system_account_bindings_account_id_claude_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."claude_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_usage_snapshots_dedup_idx" ON "account_usage_snapshots" USING btree ("account_id","kind","fetched_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_usage_snapshots_recent_idx" ON "account_usage_snapshots" USING btree ("account_id","kind","fetched_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claude_accounts_org_idx" ON "claude_accounts" USING btree ("organization_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "system_account_bindings_open_idx" ON "system_account_bindings" USING btree ("system_id") WHERE valid_to IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "system_account_bindings_system_idx" ON "system_account_bindings" USING btree ("system_id","valid_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "system_account_bindings_account_idx" ON "system_account_bindings" USING btree ("account_id","valid_from");