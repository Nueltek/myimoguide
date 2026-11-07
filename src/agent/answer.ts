import { generateObject } from 'ai';
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Env } from '../types';
import type { Db } from '../db/client';
import { agencies, facilities, services, stateFacts } from '../db/schema';
import {
  renderAgency,
  renderFact,
  renderFacilities,
  renderNeedsOfficial,
  renderService,
  renderSearchBroken,
  renderSourced,
  renderUnknown,
  renderWelcome,
} from './render';
import { searchWeb } from './search';
import {
  type ModelProvider,
  providerOf,
  routingModel,
  routingModelId,
  synthesisModelId,
} from './models';

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

/**
 * How an answer was produced. Reported to the user implicitly through the
 * wording, and logged so the pilot can state what share of questions each
 * tier carried — which is the number that makes the case for MDA access.
 */
export type AnswerTier =
  /** From a curated row: a named person checked it on a stated date. */
  | 'verified'
  /** From a live web search, attributed and explicitly unconfirmed. */
  | 'sourced'
  /** Withheld on purpose: money or safety, and no verified record. */
  | 'withheld'
  /** Nothing found anywhere. */
  | 'unknown'
  /** The search itself failed. Our fault, not an absence of information. */
  | 'error';

export interface AnswerResult {
  text: string;
  resolved: boolean;
  tier: AnswerTier;
  /** Which provider and model produced this. Logged and stored per query. */
  provider: ModelProvider;
  model: string;
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
    .enum(['greeting', 'service', 'agency', 'facility', 'about', 'none'])
    .describe(
      'greeting = hello/thanks/small talk with no question; service = a government process; ' +
      'agency = who handles, heads or can be contacted about something; ' +
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
  agencySlug: z
    .string()
    .nullable()
    .describe('Exact slug from the agencies list. Null unless kind is "agency".'),
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
  sensitivity: z
    .enum(['routine', 'payment_details', 'emergency'])
    .describe(
      'payment_details = asking for a bank account, payment reference or where to send money. ' +
      'emergency = an urgent medical, fire or security situation happening now. ' +
      'routine = everything else, including asking what a fee costs.',
    ),
});

export async function answerQuestion(input: AnswerInput): Promise<AnswerResult> {
  const { db, env, question, history } = input;

  // Stamped on every answer below, so a reply can always be traced to the
  // provider and model that produced it — including from the phone, via
  // the /status command, without opening a terminal.
  const provider = providerOf(env);
  const routed = { provider, model: routingModelId(env) };
  const synthesised = { provider, model: synthesisModelId(env) };

  // Both catalogues in ONE batch — neon-http sends it as a single request,
  // so this costs one subrequest rather than two against the 50 cap.
  //
  // Six to eight services plus a few dozen facts fit in a routing prompt
  // comfortably, so no vector search is needed at this scale. pgvector is
  // in the schema for when the catalogue outgrows a prompt.
  const [catalogue, facts, agencyList] = await db.batch([
    db
      .select({
        id: services.id,
        slug: services.slug,
        name: services.name,
        aliases: services.aliases,
        summary: services.summary,
        agencyId: services.agencyId,
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
    db
      .select({
        id: agencies.id,
        slug: agencies.slug,
        name: agencies.name,
        shortName: agencies.shortName,
        headTitle: agencies.headTitle,
        responsibilities: agencies.responsibilities,
      })
      .from(agencies)
      .where(and(eq(agencies.isPublished, true), isNotNull(agencies.slug))),
  ]);

  const route = await routeQuestion(env, question, history, catalogue, facts, agencyList);

  // A greeting is the first thing almost everyone sends. Answering it with
  // "I don't have a confirmed answer" is the worst possible opening, so
  // greetings get a welcome that states what the agent can actually do.
  if (route.kind === 'greeting') {
    return { text: renderWelcome(catalogue, facts.length > 0), resolved: true, tier: 'verified', ...routed };
  }

  // General knowledge about the state. An assistant that cannot say when
  // Imo State was created has no business calling itself a state guide,
  // and it is the first thing anyone tests.
  //
  // The confidence gate matters as much as the match. A stored fact is a
  // narrow answer to a narrow question, and a near-miss is worse than no
  // match at all: "what is Imo known FOR" once returned the nickname
  // row — "known AS the Eastern Heartland" — which answers a different
  // question and blocks the richer web answer the user wanted.
  if (route.kind === 'about' && route.factSlug && route.confidence === 'high') {
    const hit = facts.find((f) => f.slug === route.factSlug);
    if (hit) {
      const [row] = await db
        .select()
        .from(stateFacts)
        .where(eq(stateFacts.id, hit.id))
        .limit(1);
      if (row) return { text: renderFact(row), resolved: true, tier: 'verified', ...routed };
    }
  }

  // Who handles something, who heads an office, how to reach it. The
  // commonest question a state assistant gets, and the record that goes
  // stale fastest — every reshuffle changes it — which is why it is
  // edited in the dashboard rather than shipped in code.
  if (route.kind === 'agency' && route.agencySlug && route.confidence === 'high') {
    const hit = agencyList.find((g) => g.slug === route.agencySlug);
    if (hit) {
      const [row] = await db.select().from(agencies).where(eq(agencies.id, hit.id)).limit(1);
      if (row) {
        const offered = catalogue.filter((s) => s.agencyId === row.id).map((s) => ({ name: s.name }));
        return { text: renderAgency(row, offered), resolved: true, tier: 'verified', ...routed };
      }
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
          tier: 'verified',
          ...routed,
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
        tier: 'verified',
        ...routed,
        facilityId: first.id,
      };
    }
  }

  // ---------------------------------------------------------------
  // Nothing in the database. Everything below is Tier 2 and lower.
  // ---------------------------------------------------------------

  // Two classes never fall through to the web, however useful it would be.
  //
  // Payment details: scammers publish and search-optimise fake government
  // account numbers precisely because systems like this one might repeat
  // them. Repeating one would move real money to a thief.
  //
  // Emergencies: an unchecked number that rings out is the single failure
  // here that cannot be undone with an apology.
  if (route.sensitivity === 'payment_details' || route.sensitivity === 'emergency') {
    return {
      text: renderNeedsOfficial(route.sensitivity, catalogue),
      resolved: false,
      tier: 'withheld',
      ...routed,
    };
  }

  // Federal matters belong to GovGuide, not to us. Searching the web for
  // them would blur the state-level positioning the product rests on.
  if (isFederal(question)) {
    return { text: renderUnknown(catalogue), resolved: false, tier: 'unknown', ...routed };
  }

  // Tier 2: search the live web and attribute every claim.
  const web = await searchWeb(env, question, history);
  if (web.found) {
    return { text: renderSourced(web.text, web.sources), resolved: true, tier: 'sourced', ...synthesised };
  }

  // The search broke. Say that, rather than claiming no answer exists.
  if (web.error) {
    return { text: renderSearchBroken(), resolved: false, tier: 'error', ...synthesised };
  }

  // Tier 3: found nothing. Say so and name someone who can help. The log
  // of questions that land here is the most valuable output of the pilot
  // — it is the evidence for what MDA access would buy.
  return { text: renderUnknown(catalogue), resolved: false, tier: 'unknown', ...synthesised };
}

/** Federal services we deliberately do not cover. */
function isFederal(question: string): boolean {
  return /\b(nin|nimc|passport|immigration|jamb|waec|neco|cac|corporate affairs|bvn|npc|inec)\b/i.test(
    question,
  );
}

async function routeQuestion(
  env: Env,
  question: string,
  history: Array<{ role: 'user' | 'assistant'; text: string }>,
  catalogue: Array<{ slug: string; name: string; aliases: string[]; summary: string }>,
  facts: Array<{ slug: string; topic: string; aliases: string[] }>,
  agencyList: Array<{
    slug: string | null;
    name: string;
    shortName: string | null;
    headTitle: string | null;
    responsibilities: string | null;
  }>,
): Promise<z.infer<typeof routeSchema>> {
  const catalogueText = catalogue
    .map((s) => `- ${s.slug}: ${s.name}${s.aliases.length ? ` (also: ${s.aliases.join(', ')})` : ''} — ${s.summary}`)
    .join('\n');

  const factsText = facts
    .map((f) => `- ${f.slug}: ${f.topic}${f.aliases.length ? ` (also: ${f.aliases.join(', ')})` : ''}`)
    .join('\n');

  const agenciesText = agencyList
    .map(
      (g) =>
        `- ${g.slug}: ${g.name}${g.shortName ? ` (${g.shortName})` : ''}` +
        `${g.headTitle ? `, headed by the ${g.headTitle}` : ''}` +
        `${g.responsibilities ? ` — responsible for: ${g.responsibilities}` : ''}`,
    )
    .join('\n');

  const context = history
    .slice(-4)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n');

  const { object } = await generateObject({
    // Routing is a small classification job; the cheapest adequate model
    // is right, and it runs on every single message. See models.ts.
    model: routingModel(env),
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
      'Government offices available:',
      agenciesText || '(none published yet)',
      '',
      'Rules:',
      '- Pick kind="greeting" for hello, good morning, thanks, or small talk with no question in it.',
      '- Pick kind="about" ONLY when a fact above answers the question COMPLETELY. Set factSlug.',
      '  A fact that answers a nearby but different question does not count. "What is Imo known FOR"',
      '  is not answered by the fact about what it is known AS. When in doubt, set confidence="low".',
      '- Open-ended questions — "tell me about X", "what is X known for", "what is X like",',
      '  "describe X", anything wanting a summary rather than one value — are kind="none".',
      '  They are answered better by a web search than by one stored row.',
      '- Pick kind="agency" when the question asks WHO handles something, who heads an office,',
      '  which ministry is responsible, or how to contact an office — and an office above covers it.',
      '  Set agencySlug. A question about HOW to complete a process is a service, not an agency.',
      '- Pick kind="service" only when the question is about one of the catalogued services.',
      '- Pick kind="facility" when the user wants to find a hospital, health centre, pharmacy, police or similar place.',
      '- Pick kind="none" for anything else. A question with no catalogue match is still a real question — mark it "none" and it will be searched on the web, so do not force a bad match.',
      '- Federal matters (NIN, passport, JAMB, CAC) are out of scope: kind="none".',
      '- Set sensitivity carefully. It decides whether an unverified answer is allowed at all.',
      '- Set confidence="low" if you are guessing between two services or the question is too vague.',
      '- Only set lga when the user named a place that maps to one.',
    ].join('\n'),
    prompt: context ? `${context}\n\nUser: ${question}` : question,
    maxOutputTokens: 200,
    temperature: 0,
  });

  return object;
}
