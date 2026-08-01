CREATE TABLE IF NOT EXISTS "prompt_daily" (
	"system_id" varchar(64) NOT NULL,
	"day" varchar(10) NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"prompt_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_daily_system_id_day_session_id_pk" PRIMARY KEY("system_id","day","session_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_meta" (
	"system_id" varchar(64) NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"title" varchar(300) DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_meta_system_id_session_id_pk" PRIMARY KEY("system_id","session_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prompt_daily" ADD CONSTRAINT "prompt_daily_system_id_systems_system_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("system_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_meta" ADD CONSTRAINT "session_meta_system_id_systems_system_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("system_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_daily_day_idx" ON "prompt_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_daily_session_idx" ON "prompt_daily" USING btree ("system_id","session_id");