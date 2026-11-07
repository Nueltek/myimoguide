import { createAnthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Env } from '../types';
import type { Db } from '../db/client';
import { agencies, facilities, services, stateFacts } from '../db/schema';
import { renderFact, renderFacilities, renderService, renderUnknown, renderWelcome } from './render';

/**
 * The agent layer, and the single rule it exists to enforce:
 *
 *   THE MODEL ROUTES. IT DOES NOT WRITE FACTS.
 *
 * Its only job is to map a question to a row. Every fee, address, phone
 * number and document list is rendered in `render.ts` from typed columns.
 * The model never sees a position where inventing a number is possible,
 * which is what makes this safe to hand to a commissioner.
 *
 * Subrequest budget (50 per invocation on the free plan):
 *   1 — load the published services
 *   1 — the routing call
 *   1 — the facility lookup, when the question is a facility one
 */

export interface AnswerInput {
  db: Db;
  env: Env;
  question: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface AnswerResult {
  text: string;
  resolved: boolean;
  serviceId?: string;
  facilityId?: string;
}

const LGA_VALUES = [
  'Aboh Mbaise', 'Ahiazu Mbaise', 'Ehime Mbano', 'Ezinihitte Mbaise',
  'Ideato North', 'Ideato South', 'Ihitte/Uboma', 'Ikeduru', 'Isiala Mbano',
  'Isu', 'Mbaitoli', 'Ngor Okpala', 'Njaba', 'Nkwerre', 'Nwangele',
  'Obowo', 'Oguta', 'Ohaji/Egbema', 'Okigwe', 'Onuimo', 'Orlu', 'Orsu',
  'Oru East', 'Oru West', 'Owerri Municipal', 'Owerri North', 'Owerri West',
] as const;

const FACILITY_TYPES = [
  'hospital', 'primary_health_centre', 'clinic', 'pharmacy',
  'police_station', 'fire_station', 'frsc', 'nscdc',
] as const;

const routeSchema = z.object({
  kind: z
    .enum(['greeting', 'service', 'facility', 'about', 'none'])
    .describe(
      'greeting = hello/thanks/small talk with no question; service = a government process; ' +
      'facility = find a place; about = general knowledge about the state; ' +
      'none = a real question we cannot route',
    ),
  serviceSlug: z
    .string()
    .nullable()
    .describe('Exact slug from the service catalogue. Null unless kind is "service".'),
  factSlug: z
    .string()
    .nullable()
    .describe('Exact slug from the facts list. Null unless kind is "about".'),
  facilityType: z
    .enum(FACILITY_TYPES)
    .nullable()
    .describe('Null unless kind is "facility".'),
  lga: z
    .enum(LGA_VALUES)
    .nullable()
    .describe('The LGA named or clearly implied. Null if the user did not say.'),
  confidence: z
    .enum(['high', 'low'])
    .describe('low when you are guessing between options or the question is vague'),
});

export async function answerQuestion(input: AnswerInput): Promise<AnswerResult> {
  const { db, env, question, history } = input;

  // Both catalogues in ONE batch — neon-http sends it as a single request,
  // so this costs one subrequest rather than two against the 50 cap.
  //
  // Six to eight services plus a few dozen facts fit in a routing prompt
  // comfortably, so no vector search is needed at this scale. pgvector is
  // in the schema for when the catalogue outgrows a prompt.
  const [catalogue, facts] = await db.batch([
    db
      .select({
        id: services.id,
        slug: services.slug,
        name: services.name,
        aliases: services.aliases,
        summary: services.summary,
      })
      .from(services)
      .where(eq(services.isPublished, true)),
    db
      .select({
        id: stateFacts.id,
        slug: stateFacts.slug,
        topic: stateFacts.topic,
        aliases: stateFacts.aliases,
      })
      .from(stateFacts)
      .where(eq(stateFacts.isPublished, true)),
  ]);

  const route = await routeQuestion(env, question, history, catalogue, facts);

  // A greeting is the first thing almost everyone sends. Answering it with
  // "I don't have a confirmed answer" is the worst possible opening, so
  // greetings get a welcome that states what the agent can actually do.
  if (route.kind === 'greeting') {
    return { text: renderWelcome(catalogue, facts.length > 0), resolved: true };
  }

  // General knowledge about the state. An assistant that cannot say when
  // Imo State was created has no business calling itself a state guide,
  // and it is the first thing anyone tests.
  if (route.kind === 'about' && route.factSlug) {
    const hit = facts.find((f) => f.slug === route.factSlug);
    if (hit) {
      const [row] = await db
        .select()
        .from(stateFacts)
        .where(eq(stateFacts.id, hit.id))
        .limit(1);
      if (row) return { text: renderFact(row), resolved: true };
    }
  }

  if (route.kind === 'service' && route.serviceSlug && route.confidence === 'high') {
    const match = catalogue.find((s) => s.slug === route.serviceSlug);
    if (match) {
      const [row] = await db
        .select()
        .from(services)
        .leftJoin(agencies, eq(services.agencyId, agencies.id))
        .where(eq(services.id, match.id))
        .limit(1);

      if (row) {
        return {
          text: renderService(row.services, row.agencies),
          resolved: true,
          serviceId: row.services.id,
        };
      }
    }
  }

  if (route.kind === 'facility' && route.facilityType) {
    const where = route.lga
      ? and(
          eq(facilities.type, route.facilityType),
          eq(facilities.lga, route.lga),
          eq(facilities.isPublished, true),
        )
      : and(eq(facilities.type, route.facilityType), eq(facilities.isPublished, true));

    const rows = await db.select().from(facilities).where(where).limit(3);

    const first = rows[0];
    if (first) {
      return {
        text: renderFacilities(rows, route.facilityType, route.lga),
        resolved: true,
        facilityId: first.id,
      };
    }
  }

  // Nothing matched, or the model was unsure. Say so and route the person
  // to someone who can help. This path is built before coverage is widened
  // — it is the behaviour that earns trust, and the log of questions that
  // land here is the most valuable output of the pilot.
  return { text: renderUnknown(catalogue), resolved: false };
}

async function routeQuestion(
  env: Env,
  question: string,
  history: Array<{ role: 'user' | 'assistant'; text: string }>,
  catalogue: Array<{ slug: string; name: string; aliases: string[]; summary: string }>,
  facts: Array<{ slug: string; topic: string; aliases: string[] }>,
): Promise<z.infer<typeof routeSchema>> {
  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const catalogueText = catalogue
    .map((s) => `- ${s.slug}: ${s.name}${s.aliases.length ? ` (also: ${s.aliases.join(', ')})` : ''} — ${s.summary}`)
    .join('\n');

  const factsText = facts
    .map((f) => `- ${f.slug}: ${f.topic}${f.aliases.length ? ` (also: ${f.aliases.join(', ')})` : ''}`)
    .join('\n');

  const context = history
    .slice(-4)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n');

  const { object } = await generateObject({
    // Routing is a small classification job; a fast model is the right
    // choice and keeps the per-query cost in fractions of a cent.
    model: anthropic('claude-haiku-4-5'),
    schema: routeSchema,
    // AI SDK 7: `instructions`, not `system`. A { role: 'system' } entry in
    // messages is rejected by default in v7.
    instructions: [
      'You route questions about Imo State, Nigeria to a record in a catalogue.',
      'You never answer the question yourself and you never state a fee, address or phone number.',
      '',
      'Services available:',
      catalogueText || '(none published yet)',
      '',
      'General knowledge available:',
      factsText || '(none published yet)',
      '',
      'Rules:',
      '- Pick kind="greeting" for hello, good morning, thanks, or small talk with no question in it.',
      '- Pick kind="about" when the question is general knowledge about Imo State and matches a fact above. Set factSlug.',
      '- Pick kind="service" only when the question is about one of the catalogued services.',
      '- Pick kind="facility" when the user wants to find a hospital, health centre, pharmacy, police or similar place.',
      '- Pick kind="none" for anything else, including federal matters (NIN, passport, JAMB, CAC).',
      '- Set confidence="low" if you are guessing between two services or the question is too vague.',
      '- Only set lga when the user named a place that maps to one.',
    ].join('\n'),
    prompt: context ? `${context}\n\nUser: ${question}` : question,
    maxOutputTokens: 200,
    temperature: 0,
  });

  return object;
}
