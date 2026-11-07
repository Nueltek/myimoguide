/**
 * Seed general knowledge about Imo State.
 *
 * Every row carries the URL it came from and the date it was checked.
 * Nothing here is written from memory, and nothing the model produces
 * reaches this table — the agent only picks which row to return.
 *
 * Confidence is honest, not flattering:
 *   'published'  — from an official or well-sourced public page
 *   'unverified' — secondary source, shown to the user with a caveat
 *   'confirmed'  — checked by phone with a named officer. Nothing here
 *                  qualifies yet; that is Phase 1 work.
 *
 * Re-run safely: upserts on slug.
 *
 *   $env:DATABASE_URL='postgresql://...'   # PowerShell
 *   npm run db:seed:facts
 */
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { stateFacts } from '../src/db/schema';

const WIKI = 'https://en.wikipedia.org/wiki/Imo_State';
const WIKI_GOV = 'https://en.wikipedia.org/wiki/Government_of_Imo_State';

/** The date these were checked against their sources. Bump when re-verified. */
const CHECKED = new Date('2026-11-07T00:00:00Z');

const LGAS = [
  'Aboh Mbaise', 'Ahiazu Mbaise', 'Ehime Mbano', 'Ezinihitte Mbaise',
  'Ideato North', 'Ideato South', 'Ihitte/Uboma', 'Ikeduru', 'Isiala Mbano',
  'Isu', 'Mbaitoli', 'Ngor Okpala', 'Njaba', 'Nkwerre', 'Nwangele',
  'Obowo', 'Oguta', 'Ohaji/Egbema', 'Okigwe', 'Onuimo', 'Orlu', 'Orsu',
  'Oru East', 'Oru West', 'Owerri Municipal', 'Owerri North', 'Owerri West',
];

type Seed = typeof stateFacts.$inferInsert;

const FACTS: Seed[] = [
  {
    slug: 'created',
    topic: 'when Imo State was created',
    aliases: ['founded', 'established', 'state creation', 'how old is Imo State'],
    category: 'history',
    answer:
      '*Imo State was created on 3 February 1976.*\n\n' +
      'It was carved out of the former East Central State, which had itself been part of the old Eastern Region.',
    sourceUrl: WIKI,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'name-origin',
    topic: 'where the name Imo comes from',
    aliases: ['why is it called Imo', 'meaning of Imo'],
    category: 'history',
    answer:
      '*The state is named after the Imo River*, which flows along its eastern border.',
    sourceUrl: WIKI,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'capital',
    topic: 'the capital of Imo State',
    aliases: ['capital city', 'state capital'],
    category: 'geography',
    answer: '*Owerri* is the capital of Imo State.',
    sourceUrl: WIKI,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'nickname',
    topic: 'the nickname or slogan of Imo State',
    aliases: ['Eastern Heartland', 'motto', 'what is Imo called'],
    category: 'culture',
    answer: 'Imo State is known as the *Eastern Heartland*.',
    sourceUrl: WIKI,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'lgas',
    topic: 'how many local government areas Imo State has, and their names',
    aliases: ['LGAs', 'local governments', 'list of LGAs', 'how many councils'],
    category: 'government',
    answer:
      '*Imo State has 27 Local Government Areas.*\n\n' + LGAS.map((l) => `• ${l}`).join('\n'),
    sourceUrl: WIKI,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'current-governor',
    topic: 'who the current governor of Imo State is',
    aliases: ['who is the governor', 'state governor', 'Uzodimma', 'Uzodinma'],
    category: 'government',
    answer:
      '*Hope Uzodimma (APC)* is the Governor of Imo State.\n\n' +
      'He took office on 15 January 2020 and is serving a second term.',
    sourceUrl: WIKI_GOV,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'deputy-governor',
    topic: 'who the deputy governor of Imo State is',
    aliases: ['deputy governor', 'second in command'],
    category: 'government',
    answer:
      '*Lady Chinyere Ekomaru (APC)* is the Deputy Governor of Imo State, in office since 15 January 2024.',
    sourceUrl: 'https://en.wikipedia.org/wiki/Chinyere_Ekomaru',
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'first-governor',
    topic: 'who the first governor of Imo State was',
    aliases: ['first military governor', 'first civilian governor', 'Mbakwe', 'Ndubuisi Kanu'],
    category: 'history',
    answer:
      '*Navy Captain Ndubuisi Kanu* was the first Military Governor of Imo State, from March 1976.\n\n' +
      '*Chief Samuel Onunaka Mbakwe (NPP)* was the first elected civilian Governor, serving from 1 October 1979 to 31 December 1983.',
    sourceUrl: WIKI,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'senatorial-zones',
    topic: 'the senatorial zones or districts of Imo State',
    aliases: ['senatorial districts', 'zones', 'Owerri zone', 'Orlu zone', 'Okigwe zone'],
    category: 'government',
    answer:
      '*Imo State has three senatorial districts:*\n\n' +
      '• Imo East (Owerri zone)\n' +
      '• Imo West (Orlu zone)\n' +
      '• Imo North (Okigwe zone)',
    sourceUrl: WIKI,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'senators',
    topic: 'who represents Imo State in the Senate',
    aliases: ['senators', 'national assembly', 'who is my senator'],
    category: 'government',
    answer:
      '*Imo State senators (all APC):*\n\n' +
      '• Imo East — Onyewuchi Francis Ezenwa\n' +
      '• Imo North — Frank Ibezim\n' +
      '• Imo West — Osita Izunaso',
    sourceUrl: WIKI,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'population',
    topic: 'the population of Imo State',
    aliases: ['how many people live in Imo', 'population size'],
    category: 'demographics',
    answer:
      'Imo State had an estimated population of about *5.46 million* in 2022, with a density of roughly 891 people per square kilometre.\n\n' +
      'This is an estimate, not a census figure.',
    sourceUrl: WIKI,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'land-area',
    topic: 'the land area or size of Imo State',
    aliases: ['how big is Imo State', 'square kilometres', 'size'],
    category: 'geography',
    answer: 'Imo State covers roughly *5,530 square kilometres* (about 2,140 square miles).',
    sourceUrl: WIKI,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'language',
    topic: 'the languages and main ethnic group of Imo State',
    aliases: ['what language', 'Igbo', 'ethnic group', 'tribe'],
    category: 'culture',
    answer:
      'Imo State is overwhelmingly *Igbo* — about 98% of the population.\n\n' +
      '*Igbo* is the lingua franca and *English* is the official language.',
    sourceUrl: WIKI,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const db = drizzle(neon(url), { casing: 'snake_case' });

  for (const fact of FACTS) {
    await db
      .insert(stateFacts)
      .values(fact)
      .onConflictDoUpdate({
        target: stateFacts.slug,
        set: {
          topic: fact.topic,
          aliases: fact.aliases,
          answer: fact.answer,
          category: fact.category,
          sourceUrl: fact.sourceUrl ?? null,
          confidence: fact.confidence ?? 'published',
          verifiedAt: fact.verifiedAt ?? null,
          updatedAt: new Date(),
        },
      });
    console.log(`  ${fact.slug}`);
  }

  console.log(`\nSeeded ${FACTS.length} facts, all sourced and dated ${CHECKED.toDateString()}.`);
  console.log(
    '\nDeliberately NOT seeded — could not verify to a standard worth showing a commissioner:\n' +
      '  • number of ministries and the list of serving commissioners\n' +
      '  • number of Imo State House of Assembly seats\n' +
      '  • LGA chairmen\n' +
      'These are gap-list items. Collect them in Phase 1 and add them here.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
