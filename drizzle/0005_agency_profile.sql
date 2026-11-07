ALTER TABLE "agencies" ADD COLUMN "slug" varchar(96);--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "head_name" text;--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "head_title" text;--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "responsibilities" text;--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "is_published" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Backfill slugs for agencies created before this column existed, so the
-- router can name them. Short name first ("IIRS" -> "iirs"), else name.
UPDATE "agencies"
SET "slug" = trim(both '-' from lower(regexp_replace(coalesce("short_name", "name"), '[^a-zA-Z0-9]+', '-', 'g')))
WHERE "slug" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agencies_slug_idx" ON "agencies" USING btree ("slug");