CREATE TYPE "public"."fact_category" AS ENUM('history', 'geography', 'government', 'demographics', 'culture');--> statement-breakpoint
CREATE TABLE "state_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(96) NOT NULL,
	"topic" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"answer" text NOT NULL,
	"category" "fact_category" NOT NULL,
	"source_url" text,
	"confidence" "confidence" DEFAULT 'published' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"is_published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "state_facts_slug_idx" ON "state_facts" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "state_facts_published_idx" ON "state_facts" USING btree ("is_published");