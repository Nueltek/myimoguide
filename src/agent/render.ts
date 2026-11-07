import type { Agency, Facility, Service, StateFact } from '../db/schema';

/**
 * Answer rendering. Pure functions over database rows — no model involved.
 *
 * Every number the user sees is produced here, from a typed column, with
 * the date it was last verified. That is the whole safety argument: there
 * is no code path where a fee can be invented, because no model ever
 * writes one.
 *
 * WhatsApp markdown: *bold*, _italic_, ```mono```. Not Markdown's **bold**.
 */

const NAIRA = '₦';

function money(amount: string | null, currency: string): string | null {
  if (!amount) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const formatted = n.toLocaleString('en-NG', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return currency === 'NGN' ? `${NAIRA}${formatted}` : `${currency} ${formatted}`;
}

function asOf(verifiedAt: Date | null, confidence: string, sourceUrl: string | null): string {
  const date = verifiedAt
    ? verifiedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  if (confidence === 'confirmed' && date) {
    return `_Confirmed with the office on ${date}._`;
  }
  if (confidence === 'published') {
    const where = sourceUrl ? ` (${sourceUrl})` : '';
    return `_From the published source${where}${date ? `, as of ${date}` : ''}. Please confirm before you travel._`;
  }
  return '_Not yet confirmed with the office. Please call ahead before you travel._';
}

export function renderService(service: Service, agency: Agency | null): string {
  const lines: string[] = [`*${service.name}*`, '', service.summary];

  const fee = money(service.feeAmount, service.feeCurrency);
  if (fee || service.feeNote) {
    lines.push('', `*Fee:* ${fee ?? ''}${fee && service.feeNote ? ' — ' : ''}${service.feeNote ?? ''}`.trim());
  }

  if (service.requiredDocuments.length > 0) {
    lines.push('', '*What to bring:*');
    for (const doc of service.requiredDocuments) lines.push(`• ${doc}`);
  }

  if (service.steps.length > 0) {
    lines.push('', '*Steps:*');
    service.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }

  if (service.paymentChannel) lines.push('', `*Where to pay:* ${service.paymentChannel}`);
  if (service.turnaround) lines.push(`*How long:* ${service.turnaround}`);

  if (agency) {
    lines.push('', `*Office:* ${agency.name}`);
    if (agency.address) lines.push(agency.address);
    if (agency.hours) lines.push(`Open: ${agency.hours}`);
    if (agency.phone) lines.push(`Phone: ${agency.phone}`);
    if (agency.latitude != null && agency.longitude != null) {
      lines.push(mapLink(agency.latitude, agency.longitude));
    }
  }

  lines.push('', asOf(service.verifiedAt, service.confidence, service.sourceUrl));

  return lines.join('\n');
}

const FACILITY_LABEL: Record<string, string> = {
  hospital: 'hospital',
  primary_health_centre: 'primary health centre',
  clinic: 'clinic',
  pharmacy: 'pharmacy',
  police_station: 'police station',
  fire_station: 'fire station',
  frsc: 'FRSC office',
  nscdc: 'NSCDC office',
};

export function renderFacilities(
  rows: Facility[],
  type: string,
  lga: string | null,
): string {
  const label = FACILITY_LABEL[type] ?? 'facility';
  const where = lga ? ` in ${lga}` : '';
  const lines: string[] = [
    rows.length === 1
      ? `*Nearest ${label}${where}*`
      : `*${label.charAt(0).toUpperCase()}${label.slice(1)}s${where}*`,
    '',
  ];

  for (const f of rows) {
    lines.push(`*${f.name}*`);
    lines.push(f.address);
    if (f.phone) lines.push(`Phone: ${f.phone}${f.altPhone ? ` / ${f.altPhone}` : ''}`);
    if (f.isTwentyFourHour === true) lines.push('Open 24 hours');
    if (f.latitude != null && f.longitude != null) {
      lines.push(mapLink(f.latitude, f.longitude));
    }
    lines.push(asOf(f.verifiedAt, f.confidence, f.sourceUrl));
    lines.push('');
  }

  // Emergencies: the phone is the primary action, always. The agent is a
  // directory, not a dispatcher, and must never read as one.
  if (type === 'hospital' || type === 'police_station' || type === 'fire_station') {
    lines.push('_In an emergency call 112 (toll free) as well as the number above._');
  }

  return lines.join('\n').trim();
}

/**
 * The reply to "Hi" — the first message almost every user sends.
 *
 * It must never be a non-answer. Stating the covered ground up front also
 * steers the next question toward something answerable, which lifts the
 * resolution rate the pilot is measured on.
 */
export function renderWelcome(
  catalogue: Array<{ name: string }>,
  hasFacts: boolean,
): string {
  const lines = ['Welcome to *MyImoGuide*.', ''];

  if (catalogue.length > 0) {
    lines.push('Ask me about any of these and I will give you the current details:', '');
    for (const s of catalogue) lines.push(`• ${s.name}`);
    lines.push('', 'I can also find hospitals, health centres and police stations by LGA.');
  } else {
    lines.push('I can help you find hospitals, health centres and police stations across Imo State.');
  }

  if (hasFacts) {
    lines.push(
      '',
      'Ask me about the state itself too — when it was created, who governs it, the LGAs, and more.',
    );
  }

  lines.push(
    '',
    'Every answer I give comes from a verified record and carries the date it was checked. If I am not sure, I will say so rather than guess.',
  );

  return lines.join('\n');
}

/**
 * General knowledge, rendered verbatim from the stored row.
 *
 * The `answer` column is human-authored from a cited source. Nothing here
 * is generated, so the date in the reply is the date in the database.
 */
export function renderFact(fact: StateFact): string {
  return [fact.answer, '', asOf(fact.verifiedAt, fact.confidence, fact.sourceUrl)].join('\n');
}

/**
 * Tier 2: an answer assembled from live web sources.
 *
 * The framing is doing real work. It must be impossible to mistake this
 * for a verified record, which is why the hedge comes FIRST, before the
 * content, and the sources are listed in full.
 */
export function renderSourced(
  answer: string,
  sources: Array<{ title: string; url: string }>,
): string {
  const lines = [
    "I don't have this confirmed in my records yet, so here is what I found online just now:",
    '',
    answer.trim(),
  ];

  if (sources.length > 0) {
    lines.push('', '*Sources*');
    for (const s of sources) lines.push(`• ${s.title}\n${s.url}`);
  }

  lines.push('', '_Please confirm with the office before you travel or pay anything._');

  return lines.join('\n');
}

/**
 * The answer when a question touches money or safety and we have no
 * verified record.
 *
 * Deliberately refuses to fall back to the web. A bank account number
 * scraped from a search result is a fraud vector — scammers publish and
 * optimise exactly those pages — and a wrong emergency number is the one
 * failure that cannot be apologised for afterwards.
 */
export function renderNeedsOfficial(
  kind: 'payment_details' | 'emergency',
  catalogue: Array<{ name: string }>,
): string {
  if (kind === 'emergency') {
    return [
      '*If this is an emergency, call 112 now* — it is toll free from any network.',
      '',
      'I can give you the address and phone number of hospitals, health centres and police stations I have on record. Tell me which LGA you are in.',
      '',
      "I won't pass on an emergency number I have not checked myself.",
    ].join('\n');
  }

  const lines = [
    "I won't give you account or payment details I haven't confirmed with the office.",
    '',
    'Fake payment accounts for government services are common, and a wrong number here costs you money. Please get these from the agency directly, or from the official Imo State revenue portal.',
  ];

  if (catalogue.length > 0) {
    lines.push('', 'I do have confirmed details for:');
    for (const s of catalogue) lines.push(`• ${s.name}`);
  }

  return lines.join('\n');
}

export function renderUnknown(catalogue: Array<{ name: string }>): string {
  const lines = [
    "I don't have a confirmed answer for that yet, and I would rather tell you than guess.",
  ];

  if (catalogue.length > 0) {
    lines.push('', 'Right now I can help with:');
    for (const s of catalogue) lines.push(`• ${s.name}`);
  }

  lines.push(
    '',
    'For anything else about Imo State, the Ministry of Information can point you to the right office.',
    '',
    '_For federal matters such as NIN, passport, JAMB or CAC, try the federal GovGuide service._',
  );

  return lines.join('\n');
}

function mapLink(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}
