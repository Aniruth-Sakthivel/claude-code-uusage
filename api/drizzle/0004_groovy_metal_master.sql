CREATE TABLE "agent_commands" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_commands_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"system_id" varchar(64) NOT NULL,
	"action" varchar(32) NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"ack_detail" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_commands" ADD CONSTRAINT "agent_commands_system_id_systems_system_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("system_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_commands" ADD CONSTRAINT "agent_commands_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_commands_system_status_idx" ON "agent_commands" USING btree ("system_id","status");