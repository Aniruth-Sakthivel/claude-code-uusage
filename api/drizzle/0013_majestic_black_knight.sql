ALTER TABLE "claude_accounts" ADD COLUMN "account_created_at" varchar(40) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "claude_accounts" ADD COLUMN "subscription_created_at" varchar(40) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "claude_accounts" ADD COLUMN "trial_ends_at" varchar(40) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "claude_accounts" ADD COLUMN "seat_tier" varchar(64) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "claude_accounts" ADD COLUMN "user_rate_limit_tier" varchar(64) DEFAULT '' NOT NULL;