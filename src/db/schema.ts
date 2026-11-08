import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * The architectural rule this schema exists to enforce:
 *
 *   The model NEVER produces a fee, an address, or a phone number.
 *   It maps a question to a row and composes language around the row's
 *   values. Every answer therefore carries a source and a date, and the
 *   hallucination surface for facts that matter is zero.
 *
 * Which means every factual column below is typed and separate. A blob of
 * prose per service would hand the number back to the model to re-read.
 */

/** How well do we actually know this? Drives both the answer and the pitch. */
export const confidenceEnum = pgEnum('confidence', [
  /** Confirmed by phone or in person with a named officer. */
  'confirmed',
  /** Taken from an official published source, not independently checked. */
  'published',
  /** From a secondary source (news, directory). Shown with a caveat. */
  'unverified',
]);

export const lgaEnum = pgEnum('lga', [
  'Aboh Mbaise', 'Ahiazu Mbaise', 'Ehime Mbano', 'Ezinihitte Mbaise',
  'Ideato North', 'Ideato South', 'Ihitte/Uboma', 'Ikeduru', 'Isiala Mbano',
  'Isu', 'Mbaitoli', 'Ngor Okpala', 'Njaba', 'Nkwerre', 'Nwangele',
  'Obowo', 'Oguta', 'Ohaji/Egbema', 'Okigwe', 'Onuimo', 'Orlu', 'Orsu',
  'Oru East', 'Oru West', 'Owerri Municipal', 'Owerri North', 'Owerri West',
]);

/** The agencies that own services. One relationship to maintain per row. */
export const agencies = pgTable('agencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * Stable handle the router names, as with services and facts. Models
   * copy short slugs reliably; they mis-copy UUIDs often enough to matter.
   */
  slug: varchar('slug', { length: 96 }),
  name: text('name').notNull(),
  shortName: varchar('short_name', { length: 32 }),

  /**
   * Who leads it and what it is responsible for. This is what answers the
   * most common question a state assistant gets — "who do I talk to about
   * X?" — and it changes with every cabinet reshuffle, which is why it
   * lives here, editable and audited, rather than in a seed file.
   */
  headName: text('head_name'),
  headTitle: text('head_title'),
  responsibilities: text('responsibilities'),
  isPublished: boolean('is_published').notNull().default(true),

  address: text('address'),
  phone: varchar('phone', { length: 32 }),
  email: varchar('email', { length: 160 }),
  website: text('website'),
  hours: text('hours'),
  lga: lgaEnum('lga'),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),

  sourceUrl: text('source_url'),
  confidence: confidenceEnum('confidence').notNull().default('published'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedBy: text('verified_by'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('agencies_name_idx').on(t.name),
  uniqueIndex('agencies_slug_idx').on(t.slug),
]);

/**
 * A transactional government service: the thing a citizen needs to DO.
 * This is the wedge — where Google fails and a wasted trip costs real money.
 */
export const services = pgTable('services', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 96 }).notNull(),
  name: text('name').notNull(),
  /** What people actually call it: "C of O", "tax clearance", "TCC". */
  aliases: text('aliases').array().notNull().default([]),
  summary: text('summary').notNull(),

  agencyId: uuid('agency_id').references(() => agencies.id, { onDelete: 'restrict' }),

  /** Naira. numeric, never float — this is money shown to a commissioner. */
  feeAmount: numeric('fee_amount', { precision: 12, scale: 2 }),
  feeCurrency: varchar('fee_currency', { length: 3 }).notNull().default('NGN'),
  /** When the fee varies: "₦5,000–₦50,000 depending on land value". */
  feeNote: text('fee_note'),

  requiredDocuments: text('required_documents').array().notNull().default([]),
  paymentChannel: text('payment_channel'),
  turnaround: text('turnaround'),
  /** Ordered steps. Rendered verbatim, never summarised by the model. */
  steps: jsonb('steps').$type<string[]>().notNull().default([]),

  sourceUrl: text('source_url'),
  confidence: confidenceEnum('confidence').notNull().default('published'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedBy: text('verified_by'),

  /** Set false to pull a record out of answers without deleting it. */
  isPublished: boolean('is_published').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('services_slug_idx').on(t.slug),
  index('services_published_idx').on(t.isPublished),
]);

export const facilityTypeEnum = pgEnum('facility_type', [
  'hospital', 'primary_health_centre', 'clinic', 'pharmacy',
  'police_station', 'fire_station', 'frsc', 'nscdc',
]);

/**
 * Health and security facilities. Returned as a record plus a map link —
 * never as generated prose. A dead emergency number is the one failure that
 * could actually hurt someone, so `verifiedAt` is re-checked monthly.
 */
export const facilities = pgTable('facilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  type: facilityTypeEnum('type').notNull(),
  lga: lgaEnum('lga').notNull(),
  address: text('address').notNull(),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  phone: varchar('phone', { length: 32 }),
  altPhone: varchar('alt_phone', { length: 32 }),
  isTwentyFourHour: boolean('is_twenty_four_hour'),
  notes: text('notes'),

  sourceUrl: text('source_url'),
  confidence: confidenceEnum('confidence').notNull().default('published'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedBy: text('verified_by'),
  isPublished: boolean('is_published').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('facilities_type_lga_idx').on(t.type, t.lga),
  uniqueIndex('facilities_name_lga_idx').on(t.name, t.lga),
]);

export const factCategoryEnum = pgEnum('fact_category', [
  'history', 'geography', 'government', 'demographics', 'culture',
]);

/**
 * General knowledge about the state: when it was created, who governs it,
 * how many LGAs, where the name comes from.
 *
 * This does not break the "model never writes facts" rule. The `answer`
 * text is authored by a human from a cited source and stored, then
 * rendered verbatim — the model only picks which row to return. The
 * alternative, letting the model answer from its own weights, is exactly
 * the failure the whole design exists to prevent: a plausible wrong date
 * in front of someone who knows the right one.
 *
 * Churn varies enormously by row, which is why verifiedAt is per-fact.
 * "Created 3 February 1976" will never change. "The current governor" can
 * change between a demo and a follow-up meeting.
 */
export const stateFacts = pgTable('state_facts', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 96 }).notNull(),
  /** What the fact is about, for the routing prompt: "when the state was created". */
  topic: text('topic').notNull(),
  /** Other ways people ask it, to help routing. */
  aliases: text('aliases').array().notNull().default([]),
  /** The answer, verbatim. WhatsApp markdown is allowed. */
  answer: text('answer').notNull(),
  category: factCategoryEnum('category').notNull(),

  sourceUrl: text('source_url'),
  confidence: confidenceEnum('confidence').notNull().default('published'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedBy: text('verified_by'),
  isPublished: boolean('is_published').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('state_facts_slug_idx').on(t.slug),
  index('state_facts_published_idx').on(t.isPublished),
]);

/**
 * Intent routing. One row per phrasing we can match, pointing at a service
 * or facility type. pgvector for fuzzy matching; Postgres full-text for the
 * exact hits, which on a corpus this size carries more than people expect.
 *
 * 1536 dims = OpenAI text-embedding-3-small. Change the column if you
 * change the embedding model — a mismatch fails at query time, not insert.
 */
export const intents = pgTable('intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  phrase: text('phrase').notNull(),
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'cascade' }),
  facilityType: facilityTypeEnum('facility_type'),
  embedding: vector('embedding', { dimensions: 1536 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('intents_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
]);

/**
 * Every question asked, matched or not.
 *
 * The unmatched ones are the most valuable output of the pilot: they tell
 * you what to collect next, and they are the slide that turns "here is what
 * we cannot answer" into "here is what access to your MDAs would buy".
 */
export const queries = pgTable('queries', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Hashed sender — we do not need to store raw phone numbers to count users. */
  userHash: varchar('user_hash', { length: 64 }).notNull(),
  messageId: varchar('message_id', { length: 128 }).notNull(),
  question: text('question').notNull(),
  language: varchar('language', { length: 8 }),
  wasVoice: boolean('was_voice').notNull().default(false),

  matchedServiceId: uuid('matched_service_id').references(() => services.id, { onDelete: 'set null' }),
  matchedFacilityId: uuid('matched_facility_id').references(() => facilities.id, { onDelete: 'set null' }),
  /** False when we fell back to "I don't know, here is who to call". */
  wasResolved: boolean('was_resolved').notNull().default(false),
  /**
   * Which tier produced the answer: verified | sourced | withheld | unknown.
   *
   * The share each tier carries is the pitch's central number. A high
   * 'sourced' count is the concrete argument for MDA access: these are
   * questions people actually ask that only the open web could answer.
   */
  answerTier: varchar('answer_tier', { length: 16 }),
  /**
   * Which provider and model answered. Stored per query, not read from
   * config at report time, because config changes — an A/B run is
   * worthless if last week's rows silently claim today's provider.
   */
  provider: varchar('provider', { length: 16 }),
  model: varchar('model', { length: 64 }),

  answer: text('answer'),
  latencyMs: integer('latency_ms'),
  /** null until the user taps the thumbs prompt. */
  wasHelpful: boolean('was_helpful'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('queries_message_id_idx').on(t.messageId),
  index('queries_unresolved_idx').on(t.wasResolved, t.createdAt),
]);

/**
 * Dashboard sessions.
 *
 * Server-side, so revocation is immediate — a stolen cookie is killed by
 * deleting a row, which a signed stateless token cannot offer. On a
 * government system the ability to cut off access now matters more than
 * saving a database read.
 *
 * The cookie carries a random id; only its SHA-256 is stored, so a
 * database leak does not hand over live sessions.
 */
export const adminSessions = pgTable('admin_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => adminUsers.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  /**
   * How far through sign-in this session is.
   *   enrolling — password correct, no 2FA set up yet: may only reach setup
   *   pending   — password correct, 2FA code not yet given: may only reach the code page
   *   full      — both factors given
   * Partial sessions live ten minutes. Moving to full issues a new token
   * rather than upgrading this one, so a token seen during sign-in is
   * worthless afterwards.
   */
  stage: varchar('stage', { length: 16 }).notNull().default('full'),
  /** Wrong 2FA codes on this session. Five ends it. */
  failedAttempts: integer('failed_attempts').notNull().default(0),
  /**
   * When this session last proved the second factor: at sign-in, and again
   * each time the user re-enters a code for a sensitive action (managing
   * accounts, new recovery codes). Those actions need it to be recent, so
   * a laptop left signed in cannot be used to add an account.
   */
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('admin_sessions_token_idx').on(t.tokenHash),
  index('admin_sessions_expiry_idx').on(t.expiresAt),
]);

/** Dashboard users. Government project: 2FA is mandatory, not optional. */
export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 160 }).notNull(),
  /** PBKDF2-SHA256, salted, at the platform's iteration cap. See src/admin/auth.ts. */
  passwordHash: text('password_hash').notNull(),
  /** Sealed with AES-GCM; see src/admin/secretbox.ts. Never stored in plain text. */
  totpSecret: text('totp_secret'),
  totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
  /**
   * Secret shown during setup, before the user proves they scanned it.
   * Kept separate so reloading the setup page shows the same QR code
   * rather than invalidating the one already in their app.
   */
  totpPendingSecret: text('totp_pending_secret'),
  /** Last time step accepted. Codes at or before it are replays. */
  totpLastStep: integer('totp_last_step'),
  /** SHA-256 of each unused recovery code. A used code is removed. */
  recoveryCodeHashes: text('recovery_code_hashes').array().notNull().default([]),
  /** administrator | editor | viewer. See src/admin/access.ts for what each may do. */
  role: varchar('role', { length: 16 }).notNull().default('editor'),
  /** As the person gave it when accepting their invitation. Shown in the dashboard and audit views. */
  fullName: varchar('full_name', { length: 120 }),
  /** Deactivated, never deleted: the audit log must keep resolving to a person. */
  isActive: boolean('is_active').notNull().default(true),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('admin_users_email_idx').on(t.email),
  check('admin_users_role_check', sql`${t.role} in ('administrator', 'editor', 'viewer')`),
]);

/**
 * Invitations to the dashboard.
 *
 * An administrator invites by email and role; the system issues a link
 * that works once and expires. The invitee chooses their own password and
 * sets up 2FA in the same visit, so nobody ever knows anyone else's
 * password and there is no temporary one for someone else to use first.
 *
 * Only the SHA-256 of the link's token is stored. A database leak yields
 * no usable invitations.
 */
export const adminInvites = pgTable('admin_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 160 }).notNull(),
  role: varchar('role', { length: 16 }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  invitedBy: uuid('invited_by').references(() => adminUsers.id, { onDelete: 'set null' }),
  invitedByEmail: varchar('invited_by_email', { length: 160 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedUserId: uuid('accepted_user_id').references(() => adminUsers.id, { onDelete: 'set null' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('admin_invites_token_idx').on(t.tokenHash),
  index('admin_invites_email_idx').on(t.email),
  check('admin_invites_role_check', sql`${t.role} in ('administrator', 'editor', 'viewer')`),
]);

/**
 * Append-only audit log. Does double duty: it is a real security control,
 * and it is a demo feature — a government buyer wants to see who changed a
 * published fee and when. Never UPDATE or DELETE rows in this table.
 */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id').references(() => adminUsers.id, { onDelete: 'set null' }),
  actorEmail: varchar('actor_email', { length: 160 }).notNull(),
  action: varchar('action', { length: 32 }).notNull(),
  tableName: varchar('table_name', { length: 64 }).notNull(),
  rowId: uuid('row_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ipAddress: varchar('ip_address', { length: 45 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('audit_log_row_idx').on(t.tableName, t.rowId, t.createdAt),
  // Sign-in throttling counts recent failures by account and by address.
  index('audit_log_action_actor_idx').on(t.action, t.actorEmail, t.createdAt),
  index('audit_log_action_ip_idx').on(t.action, t.ipAddress, t.createdAt),
]);

export type Service = typeof services.$inferSelect;
export type Facility = typeof facilities.$inferSelect;
export type Agency = typeof agencies.$inferSelect;
export type StateFact = typeof stateFacts.$inferSelect;
