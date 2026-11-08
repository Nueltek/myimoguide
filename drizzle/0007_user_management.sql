CREATE TABLE "admin_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(160) NOT NULL,
	"role" varchar(16) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"invited_by" uuid,
	"invited_by_email" varchar(160) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_invites_role_check" CHECK ("admin_invites"."role" in ('administrator', 'editor', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "full_name" varchar(120);--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_invites" ADD CONSTRAINT "admin_invites_invited_by_admin_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_invites" ADD CONSTRAINT "admin_invites_accepted_user_id_admin_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_invites_token_idx" ON "admin_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_invites_email_idx" ON "admin_invites" USING btree ("email");--> statement-breakpoint
-- Hand-added: accounts created before roles existed were given 'admin'.
-- They become administrators. Anything else unrecognised becomes a viewer,
-- the role that can change nothing, rather than failing the migration.
UPDATE "admin_users" SET "role" = 'administrator' WHERE "role" = 'admin';--> statement-breakpoint
UPDATE "admin_users" SET "role" = 'viewer' WHERE "role" NOT IN ('administrator', 'editor', 'viewer');--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_role_check" CHECK ("admin_users"."role" in ('administrator', 'editor', 'viewer'));