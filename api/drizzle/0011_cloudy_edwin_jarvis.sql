CREATE TABLE "initiative_clients" (
	"user_id" integer NOT NULL,
	"initiative_id" integer NOT NULL,
	CONSTRAINT "initiative_clients_user_id_initiative_id_pk" PRIMARY KEY("user_id","initiative_id")
);
--> statement-breakpoint
ALTER TABLE "initiative_clients" ADD CONSTRAINT "initiative_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_clients" ADD CONSTRAINT "initiative_clients_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "initiative_clients_initiative_idx" ON "initiative_clients" USING btree ("initiative_id");