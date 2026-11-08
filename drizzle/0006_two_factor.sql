ALTER TABLE "admin_sessions" ADD COLUMN "stage" varchar(16) DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_pending_secret" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_last_step" integer;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "recovery_code_hashes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_log_action_actor_idx" ON "audit_log" USING btree ("action","actor_email","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_ip_idx" ON "audit_log" USING btree ("action","ip_address","created_at");