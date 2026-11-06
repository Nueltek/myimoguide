CREATE TYPE "public"."confidence" AS ENUM('confirmed', 'published', 'unverified');--> statement-breakpoint
CREATE TYPE "public"."facility_type" AS ENUM('hospital', 'primary_health_centre', 'clinic', 'pharmacy', 'police_station', 'fire_station', 'frsc', 'nscdc');--> statement-breakpoint
CREATE TYPE "public"."lga" AS ENUM('Aboh Mbaise', 'Ahiazu Mbaise', 'Ehime Mbano', 'Ezinihitte Mbaise', 'Ideato North', 'Ideato South', 'Ihitte/Uboma', 'Ikeduru', 'Isiala Mbano', 'Isu', 'Mbaitoli', 'Ngor Okpala', 'Njaba', 'Nkwerre', 'Nwangele', 'Obowo', 'Oguta', 'Ohaji/Egbema', 'Okigwe', 'Onuimo', 'Orlu', 'Orsu', 'Oru East', 'Oru West', 'Owerri Municipal', 'Owerri North', 'Owerri West');--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(160) NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" text,
	"totp_enabled_at" timestamp with time zone,
	"role" varchar(16) DEFAULT 'editor' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"short_name" varchar(32),
	"address" text,
	"phone" varchar(32),
	"email" varchar(160),
	"website" text,
	"hours" text,
	"lga" "lga",
	"latitude" double precision,
	"longitude" double precision,
	"source_url" text,
	"confidence" "confidence" DEFAULT 'published' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_email" varchar(160) NOT NULL,
	"action" varchar(32) NOT NULL,
	"table_name" varchar(64) NOT NULL,
	"row_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"ip_address" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "facility_type" NOT NULL,
	"lga" "lga" NOT NULL,
	"address" text NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"phone" varchar(32),
	"alt_phone" varchar(32),
	"is_twenty_four_hour" boolean,
	"notes" text,
	"source_url" text,
	"confidence" "confidence" DEFAULT 'published' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"is_published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phrase" text NOT NULL,
	"service_id" uuid,
	"facility_type" "facility_type",
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_hash" varchar(64) NOT NULL,
	"message_id" varchar(128) NOT NULL,
	"question" text NOT NULL,
	"language" varchar(8),
	"was_voice" boolean DEFAULT false NOT NULL,
	"matched_service_id" uuid,
	"matched_facility_id" uuid,
	"was_resolved" boolean DEFAULT false NOT NULL,
	"answer" text,
	"latency_ms" integer,
	"was_helpful" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(96) NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"summary" text NOT NULL,
	"agency_id" uuid,
	"fee_amount" numeric(12, 2),
	"fee_currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"fee_note" text,
	"required_documents" text[] DEFAULT '{}' NOT NULL,
	"payment_channel" text,
	"turnaround" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_url" text,
	"confidence" "confidence" DEFAULT 'published' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"is_published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_admin_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queries" ADD CONSTRAINT "queries_matched_service_id_services_id_fk" FOREIGN KEY ("matched_service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queries" ADD CONSTRAINT "queries_matched_facility_id_facilities_id_fk" FOREIGN KEY ("matched_facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_idx" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "agencies_name_idx" ON "agencies" USING btree ("name");--> statement-breakpoint
CREATE INDEX "audit_log_row_idx" ON "audit_log" USING btree ("table_name","row_id","created_at");--> statement-breakpoint
CREATE INDEX "facilities_type_lga_idx" ON "facilities" USING btree ("type","lga");--> statement-breakpoint
CREATE UNIQUE INDEX "facilities_name_lga_idx" ON "facilities" USING btree ("name","lga");--> statement-breakpoint
CREATE INDEX "intents_embedding_idx" ON "intents" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "queries_message_id_idx" ON "queries" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "queries_unresolved_idx" ON "queries" USING btree ("was_resolved","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "services_slug_idx" ON "services" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "services_published_idx" ON "services" USING btree ("is_published");