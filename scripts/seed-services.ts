/**
 * Seed the service catalogue from published sources.
 *
 * WHAT THE RESEARCH FOUND, and why the catalogue looks like this.
 *
 * Imo State publishes WHICH taxes exist and WHEN they are due. It does
 * not publish WHAT THEY COST. The IIRS services page lists six services
 * with no fees and no document lists. The tax policies page names eight
 * taxes with deadlines and not one rate. Fee figures for land services
 * exist only on property blogs, as wide ranges, explicitly marked as
 * estimates and roughly two years old.
 *
 * That gap IS the product, and it is the pitch. Every `feeAmount` below
 * is null on purpose. None of them is an oversight, and none should be
 * filled from a blog — a wrong fee in front of a commissioner costs more
 * than an admitted gap.
 *
 * The exception is PAYE, where the rates are federal statute rather than
 * state discretion, so they are both knowable and checkable.
 *
 * Confidence is honest:
 *   published   — from the agency's own site
 *   unverified  — secondary source; shown to users with a caveat
 *   confirmed   — checked by phone with a named officer. NOTHING here
 *                 qualifies. That is Phase 1 fieldwork, and the 15-20
 *                 demo-critical facts should reach it before the pitch.
 *
 *   $env:DATABASE_URL='postgresql://...'
 *   npm run db:seed:services
 */
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { agencies, services } from '../src/db/schema';

const CHECKED = new Date('2026-11-07T00:00:00Z');

const IIRS_SITE = 'https://www.iirs.im.gov.ng/services';
const IIRS_POLICIES = 'https://www.iirs.im.gov.ng/tax_policies';
const PIT_SOURCE = 'https://www.adeolaoyinlade.com/en/understanding-personal-income-tax-under-the-nigerian-tax-act-2025/';
const COFO_SOURCE = 'https://affablehomes.com.ng/guide-how-get-certificate-of-occupancy-land-imo-state/';

type AgencySeed = typeof agencies.$inferInsert & { key: string };
type ServiceSeed = Omit<typeof services.$inferInsert, 'agencyId'> & { agencyKey: string };

const AGENCIES: AgencySeed[] = [
  {
    key: 'iirs',
    name: 'Imo State Internal Revenue Service',
    shortName: 'IIRS',
    address: '76 Okigwe Road, opposite the Civil Defence Corps, Owerri, Imo State',
    phone: '+234 704 414 3059',
    email: 'enquiries@iirs.im.gov.ng',
    website: 'https://www.iirs.im.gov.ng',
    lga: 'Owerri Municipal',
    sourceUrl: IIRS_SITE,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    key: 'lands',
    name: 'Imo State Ministry of Lands, Survey and Urban Planning',
    shortName: 'Ministry of Lands',
    // From a property blog, not the ministry. Confirm before the pitch —
    // sending someone to the wrong building is the cheapest way to lose
    // their trust in the whole system.
    address: 'Block 7, Imo State Secretariat, Port Harcourt Road, Owerri, Imo State',
    lga: 'Owerri Municipal',
    sourceUrl: COFO_SOURCE,
    confidence: 'unverified',
    verifiedAt: CHECKED,
  },
];

const SERVICES: ServiceSeed[] = [
  {
    slug: 'tax-clearance-certificate',
    name: 'Tax Clearance Certificate (TCC)',
    aliases: ['TCC', 'tax clearance', 'tax certificate', 'clearance certificate'],
    agencyKey: 'iirs',
    summary:
      'Proof that your taxes are up to date for the last three years. Required for government contracts, loans, some visa applications and vehicle transactions.',
    feeNote: 'The IIRS does not publish a TCC fee. Confirm the current amount with the office before you travel.',
    requiredDocuments: [
      'Taxpayer Identification Number (TIN)',
      'Evidence of tax payments for the relevant years',
      'Valid government-issued ID',
    ],
    paymentChannel:
      'Pay using the correct revenue code through an approved channel, then present proof of payment at the IIRS office.',
    steps: [
      'Register or sign in on the IIRS self-service portal.',
      'Confirm your profile and tax records are up to date.',
      'Determine the amount due and pay using the correct revenue code.',
      'Visit the IIRS office with your proof of payment.',
    ],
    sourceUrl: IIRS_SITE,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'paye-remittance',
    name: 'PAYE — Pay As You Earn',
    aliases: ['PAYE', 'employee tax', 'salary tax', 'payroll tax', 'income tax rates'],
    agencyKey: 'iirs',
    summary:
      'Tax deducted from employee salaries by the employer and remitted to the Imo State Internal Revenue Service.',
    // Federal statute, not state discretion — so unlike every other fee
    // here this one is both knowable and checkable. Note the Act CHANGED
    // the bands from 1 January 2026: anything quoting the old PITA 2011
    // schedule is now wrong, which is exactly the failure a model
    // answering from memory would produce today.
    feeNote: [
      'Charged on annual taxable income in bands (Nigeria Tax Act 2025, in force 1 January 2026):',
      '• First ₦800,000 — 0%',
      '• Next ₦2,200,000 (to ₦3m) — 15%',
      '• Next ₦9,000,000 (to ₦12m) — 18%',
      '• Next ₦13,000,000 (to ₦25m) — 21%',
      '• Next ₦25,000,000 (to ₦50m) — 23%',
      '• Above ₦50,000,000 — 25%',
      '',
      'Rent relief: 20% of annual rent, capped at ₦500,000.',
    ].join('\n'),
    requiredDocuments: ['Employer TIN', 'Payroll schedule for the period', 'Evidence of deduction'],
    paymentChannel: 'Remit to the IIRS using the correct revenue code.',
    turnaround: 'Remit before the 10th day of the month following the deduction.',
    steps: [
      'Deduct PAYE from each employee salary using the current bands.',
      'Prepare the payroll schedule for the month.',
      'Remit to the IIRS before the 10th of the following month.',
      'File the annual employer return by 31 January.',
    ],
    sourceUrl: PIT_SOURCE,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'direct-assessment',
    name: 'Direct Assessment (self-employed income tax)',
    aliases: ['direct assessment', 'self employed tax', 'business income tax', 'DA'],
    agencyKey: 'iirs',
    summary:
      'Personal income tax for self-employed people and business owners, assessed on the previous year of income.',
    feeNote:
      'Assessed on your income using the same bands as PAYE. The IIRS determines the amount after you file.',
    requiredDocuments: ['Taxpayer Identification Number (TIN)', 'Statement of previous year income', 'Valid ID'],
    paymentChannel: 'Pay using the correct revenue code through an approved channel.',
    turnaround: 'File the annual return within 90 days of the new year — by 31 March.',
    steps: [
      'Register on the IIRS self-service portal if you have not already.',
      'File a return of your previous year income.',
      'Receive your assessment from the IIRS.',
      'Pay using the correct revenue code and keep the receipt.',
    ],
    sourceUrl: IIRS_POLICIES,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'vehicle-registration',
    name: 'Vehicle registration and document renewal',
    aliases: ['vehicle papers', 'car registration', 'plate number', 'licence renewal', 'roadworthiness'],
    agencyKey: 'iirs',
    summary:
      'Registering a vehicle and renewing vehicle documents through the Imo State Internal Revenue Service.',
    feeNote:
      'The IIRS does not publish a fee schedule for vehicle documents. Confirm the current amount with the office — this is a service where people are commonly overcharged for not knowing the correct figure.',
    paymentChannel: 'Pay using the correct revenue code through an approved channel.',
    steps: [
      'Sign in to the IIRS self-service portal.',
      'Select vehicle registration or renewal.',
      'Pay using the correct revenue code.',
      'Present proof of payment to collect your documents.',
    ],
    sourceUrl: IIRS_SITE,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
  {
    slug: 'certificate-of-occupancy',
    name: 'Certificate of Occupancy (C of O)',
    aliases: ['C of O', 'CofO', 'land title', 'land certificate', 'certificate of occupancy'],
    agencyKey: 'lands',
    summary:
      'The state document confirming your legal right to occupy a parcel of land, signed by the Governor.',
    feeNote:
      'Fees are not published by the ministry. Secondary sources suggest the total commonly runs into six figures once survey, advertisement, processing and statutory charges are included, but these are estimates. Confirm the current schedule with the ministry before budgeting.',
    requiredDocuments: [
      'Completed application form',
      'Proof of ownership (deed of conveyance or sale agreement)',
      'Survey plan from a licensed surveyor',
      'Valid government-issued ID',
      'Recent passport photograph',
      'Tax Clearance Certificate',
      'Affidavit of ownership',
      'Receipts for any land charges already paid',
    ],
    turnaround: 'Commonly three months to a year, depending on the file.',
    steps: [
      'Request an official search at the ministry to confirm ownership and boundaries.',
      'Engage a licensed surveyor for a survey plan.',
      'Complete and submit the application with supporting documents.',
      'Pay the application fees through the approved channel and keep receipts.',
      'Wait for publication of notices inviting objections (about 21 days).',
      'Attend the site inspection by a ministry officer.',
      'On approval, pay the statutory fees to the government account.',
      'Collect the certificate and register it with the land registry.',
    ],
    sourceUrl: COFO_SOURCE,
    // Secondary source. Everything here needs confirming with the ministry.
    confidence: 'unverified',
    verifiedAt: CHECKED,
  },
  {
    slug: 'land-use-charge',
    name: 'Land Use Charge',
    aliases: ['land use charge', 'property tax', 'land charge', 'tenement rate'],
    agencyKey: 'iirs',
    summary:
      'An annual charge on land and landed property, consolidating the separate land-based charges into one under the Imo State Land Use Charge Law 2020.',
    feeNote:
      'Rates are set under the Land Use Charge Law 2020 and are not published online. Confirm your property assessment with the IIRS.',
    paymentChannel: 'Pay using the correct revenue code through an approved channel.',
    steps: [
      'Obtain your property assessment from the IIRS.',
      'Pay using the correct revenue code.',
      'Keep the receipt as evidence of payment.',
    ],
    sourceUrl: IIRS_POLICIES,
    confidence: 'published',
    verifiedAt: CHECKED,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = drizzle(neon(url), { casing: 'snake_case' });

  const ids = new Map<string, string>();

  for (const { key, ...agency } of AGENCIES) {
    const existing = await db
      .select({ id: agencies.id })
      .from(agencies)
      .where(eq(agencies.name, agency.name))
      .limit(1);

    if (existing[0]) {
      await db.update(agencies).set({ ...agency, updatedAt: new Date() }).where(eq(agencies.id, existing[0].id));
      ids.set(key, existing[0].id);
    } else {
      const [row] = await db.insert(agencies).values(agency).returning({ id: agencies.id });
      if (!row) throw new Error(`failed to insert agency ${agency.name}`);
      ids.set(key, row.id);
    }
    console.log(`  agency: ${agency.name}`);
  }

  for (const { agencyKey, ...service } of SERVICES) {
    const agencyId = ids.get(agencyKey);
    if (!agencyId) throw new Error(`unknown agency key ${agencyKey}`);

    await db
      .insert(services)
      .values({ ...service, agencyId })
      .onConflictDoUpdate({
        target: services.slug,
        set: { ...service, agencyId, updatedAt: new Date() },
      });
    console.log(`  service: ${service.name}`);
  }

  const unpriced = SERVICES.filter((s) => !s.feeAmount).length;
  console.log(`\nSeeded ${AGENCIES.length} agencies and ${SERVICES.length} services.`);
  console.log(
    `\n${unpriced} of ${SERVICES.length} services carry NO confirmed fee. That is the finding, not a` +
      '\nshortfall in the seeding: Imo State publishes which taxes exist and when' +
      '\nthey are due, never what they cost.' +
      '\n\nBefore the pitch, phone-confirm at minimum:' +
      '\n  • the TCC fee' +
      '\n  • vehicle registration and renewal fees' +
      '\n  • the C of O fee schedule, and the ministry address (currently from a blog)' +
      '\nThose are the questions a commissioner is most likely to test.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
