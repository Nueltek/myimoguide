import { Hono, type Context } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { agencies, services } from '../../db/schema';
import { audit, isUniqueViolation, type Ctx } from '../context';
import { Form, uniqueSlug, type Errors } from '../validate';
import { FormPage, Grid, Provenance, Section, SelectField, TextArea, TextField } from '../forms';
import { ConfidenceBadge, Icon, Shell, formatDate } from '../layout';
import { isUuid } from './util';

/**
 * Services: the government processes a citizen needs to DO.
 *
 * A service added here is answerable on the very next WhatsApp question,
 * with no deploy — the agent reads the catalogue from the database on
 * every message. That is what closes the loop from the Questions page:
 * see what people ask, add the record, and the next person gets a
 * verified answer instead of a web search.
 */
export const servicesAdmin = new Hono<Ctx>();

const LABELS: Record<string, string> = {
  name: 'Service name',
  summary: 'Summary',
  agencyId: 'Agency',
  aliases: 'Other names',
  feeAmount: 'Fee',
  feeNote: 'Fee note',
  paymentChannel: 'Where to pay',
  turnaround: 'How long it takes',
  requiredDocuments: 'Required documents',
  steps: 'Steps',
  sourceUrl: 'Source URL',
  verifiedBy: 'Confirmed by',
  confidence: 'Confidence',
};

/** Form values exactly as submitted; isPublished is '1' or '0', as the checkbox posts it. */
type Values = Record<string, string>;

servicesAdmin.get('/', async (c) => {
  const rows = await c
    .get('db')
    .select({
      id: services.id,
      name: services.name,
      agency: agencies.shortName,
      agencyName: agencies.name,
      feeAmount: services.feeAmount,
      confidence: services.confidence,
      verifiedAt: services.verifiedAt,
      isPublished: services.isPublished,
    })
    .from(services)
    .leftJoin(agencies, eq(services.agencyId, agencies.id))
    .orderBy(asc(services.name));

  return c.html(
    <Shell title="Services" path="/admin/services" email={c.get('user').email}>
      <Saved c={c} />
      <div class="toolbar">
        <p class="lede" style="margin:0">
          What the assistant answers from. A blank fee is never guessed — it says the fee is not confirmed.
        </p>
        <span class="spacer" />
        <a class="btn primary" href="/admin/services/new">
          <Icon name="plus" /> New service
        </a>
      </div>
      <div class="panel">
        {rows.length === 0 ? (
          <div class="empty">
            No services yet. <a href="/admin/services/new">Add the first one</a>.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th style="width:150px">Agency</th>
                <th style="width:130px">Fee</th>
                <th style="width:120px">Confidence</th>
                <th style="width:115px">Verified</th>
                <th style="width:70px"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr>
                  <td class="t-strong">
                    {s.name}
                    {!s.isPublished ? (
                      <span class="badge muted" style="margin-left:8px">
                        Hidden
                      </span>
                    ) : null}
                  </td>
                  <td class="t-dim" title={s.agencyName ?? ''}>
                    {s.agency ?? s.agencyName ?? '—'}
                  </td>
                  <td class="num">
                    {s.feeAmount ? `₦${Number(s.feeAmount).toLocaleString('en-NG')}` : <span class="t-dim">Not confirmed</span>}
                  </td>
                  <td>
                    <ConfidenceBadge value={s.confidence} />
                  </td>
                  <td class="num t-dim">{formatDate(s.verifiedAt)}</td>
                  <td>
                    <a class="btn sm" href={`/admin/services/${s.id}`}>
                      Edit
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>,
  );
});

servicesAdmin.get('/new', async (c) => renderForm(c, { mode: 'new', values: { confidence: 'unverified' }, errors: {} }));

servicesAdmin.post('/new', async (c) => {
  const form = new Form(await c.req.formData());
  const data = await parse(c, form);
  if (!form.ok) return renderForm(c, { mode: 'new', values: rawValues(form), errors: form.errors }, 422);

  const db = c.get('db');
  const slug = await uniqueSlug(data.name, async (s) =>
    (await db.select({ id: services.id }).from(services).where(eq(services.slug, s)).limit(1)).length > 0,
  );

  try {
    const [row] = await db.insert(services).values({ ...data, slug }).returning();
    await audit(c, 'create', 'services', row!.id, null, row);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    form.errors.name = 'A service with this name already exists.';
    return renderForm(c, { mode: 'new', values: rawValues(form), errors: form.errors }, 422);
  }
  return c.redirect('/admin/services?saved=created');
});

servicesAdmin.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return c.notFound();
  const [row] = await c.get('db').select().from(services).where(eq(services.id, id)).limit(1);
  if (!row) return c.notFound();

  return renderForm(c, {
    mode: 'edit',
    id,
    slug: row.slug,
    verifiedAt: row.verifiedAt,
    values: {
      name: row.name,
      summary: row.summary,
      agencyId: row.agencyId ?? '',
      aliases: row.aliases.join(', '),
      feeAmount: row.feeAmount ?? '',
      feeNote: row.feeNote ?? '',
      paymentChannel: row.paymentChannel ?? '',
      turnaround: row.turnaround ?? '',
      requiredDocuments: row.requiredDocuments.join('\n'),
      steps: row.steps.join('\n'),
      sourceUrl: row.sourceUrl ?? '',
      verifiedBy: row.verifiedBy ?? '',
      confidence: row.confidence,
      isPublished: row.isPublished ? '1' : '0',
    },
    errors: {},
  });
});

servicesAdmin.post('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return c.notFound();
  const db = c.get('db');
  const [before] = await db.select().from(services).where(eq(services.id, id)).limit(1);
  if (!before) return c.notFound();

  const form = new Form(await c.req.formData());
  const data = await parse(c, form);
  if (!form.ok) {
    return renderForm(
      c,
      { mode: 'edit', id, slug: before.slug, verifiedAt: before.verifiedAt, values: rawValues(form), errors: form.errors },
      422,
    );
  }

  const [after] = await db.update(services).set(data).where(eq(services.id, id)).returning();
  await audit(c, 'update', 'services', id, before, after);
  return c.redirect('/admin/services?saved=updated');
});

/* ------------------------------------------------------------------ */

async function parse(c: Context<Ctx>, form: Form) {
  const name = form.text('name', { required: true, max: 200, label: LABELS.name! });
  const summary = form.text('summary', { required: true, max: 600, label: LABELS.summary! });
  const fee = form.number('feeAmount', { min: 0, max: 100_000_000, label: LABELS.feeAmount! });
  const confidence = form.oneOf('confidence', ['confirmed', 'published', 'unverified'] as const, {
    required: true,
    label: LABELS.confidence!,
  });

  // The agency must exist. A hand-crafted POST with a made-up id would
  // otherwise fail at the foreign key as a 500.
  const agencyRaw = form.raw('agencyId');
  let agencyId: string | null = null;
  if (agencyRaw) {
    const ok =
      isUuid(agencyRaw) &&
      (await c.get('db').select({ id: agencies.id }).from(agencies).where(eq(agencies.id, agencyRaw)).limit(1)).length > 0;
    if (ok) agencyId = agencyRaw;
    else form.errors.agencyId = 'Choose an agency from the list.';
  }

  return {
    name: name ?? '',
    summary: summary ?? '',
    agencyId,
    aliases: form.list('aliases').slice(0, 20),
    feeAmount: fee === null ? null : fee.toFixed(2),
    feeNote: form.text('feeNote', { max: 2000, label: LABELS.feeNote! }),
    paymentChannel: form.text('paymentChannel', { max: 300, label: LABELS.paymentChannel! }),
    turnaround: form.text('turnaround', { max: 200, label: LABELS.turnaround! }),
    requiredDocuments: form.lines('requiredDocuments', { maxItems: 30, label: LABELS.requiredDocuments! }),
    steps: form.lines('steps', { maxItems: 30, label: LABELS.steps! }),
    sourceUrl: form.url('sourceUrl', LABELS.sourceUrl!),
    verifiedBy: form.text('verifiedBy', { max: 200, label: LABELS.verifiedBy! }),
    confidence: confidence ?? 'unverified',
    isPublished: form.checkbox('isPublished'),
    // A save is a statement that someone looked at this today.
    verifiedAt: new Date(),
    updatedAt: new Date(),
  };
}

function rawValues(form: Form): Values {
  const v: Values = {};
  for (const k of Object.keys(LABELS)) v[k] = form.raw(k);
  v.isPublished = form.checkbox('isPublished') ? '1' : '0';
  return v;
}

async function renderForm(
  c: Context<Ctx>,
  s: { mode: 'new' | 'edit'; id?: string; slug?: string; verifiedAt?: Date | null; values: Values; errors: Errors },
  status: 200 | 422 = 200,
) {
  const agencyRows = await c
    .get('db')
    .select({ id: agencies.id, name: agencies.name, shortName: agencies.shortName })
    .from(agencies)
    .orderBy(asc(agencies.name));
  const v = s.values;
  const e = s.errors;
  const isNew = s.mode === 'new';

  return c.html(
    <Shell title={isNew ? 'New service' : v.name || 'Edit service'} path="/admin/services" email={c.get('user').email}>
      <FormPage
        title={isNew ? 'Add a service' : 'Edit service'}
        back={{ href: '/admin/services', label: 'All services' }}
        action={isNew ? '/admin/services/new' : `/admin/services/${s.id}`}
        submit={isNew ? 'Create service' : 'Save changes'}
        busy={isNew ? 'Creating...' : 'Saving...'}
        errors={e}
        labels={LABELS}
        footnote={isNew ? 'Answerable on the next question — no deploy needed.' : `Last verified ${formatDate(s.verifiedAt ?? null)}`}
      >
        <Section title="What it is">
          <TextField
            name="name"
            label={LABELS.name!}
            required
            value={v.name}
            error={e.name}
            maxLength={200}
            hint={s.slug ? undefined : 'As a resident would recognise it, e.g. "Certificate of Occupancy".'}
          />
          {s.slug ? <p class="slug" style="margin:-8px 0 14px">id: {s.slug}</p> : null}
          <TextArea
            name="summary"
            label={LABELS.summary!}
            required
            value={v.summary}
            error={e.summary}
            maxLength={600}
            hint="One or two sentences, read to the user verbatim."
          />
          <Grid>
            <SelectField
              name="agencyId"
              label={LABELS.agencyId!}
              value={v.agencyId}
              error={e.agencyId}
              blank="— Not assigned —"
              options={agencyRows.map((a) => ({ value: a.id, label: a.shortName ? `${a.shortName} — ${a.name}` : a.name }))}
              hint={agencyRows.length === 0 ? 'No agencies yet. Add one under Agencies first.' : undefined}
            />
            <TextField
              name="aliases"
              label={LABELS.aliases!}
              value={v.aliases}
              error={e.aliases}
              hint="Comma-separated: what people actually call it. Helps the assistant recognise the question."
            />
          </Grid>
        </Section>

        <Section title="Cost and payment" note="Leave the fee blank unless it is confirmed. The assistant says so rather than guessing.">
          <Grid>
            <TextField
              name="feeAmount"
              label={LABELS.feeAmount!}
              value={v.feeAmount}
              error={e.feeAmount}
              inputmode="decimal"
              placeholder="e.g. 15,000"
              hint="In naira. Commas and the ₦ sign are fine."
            />
            <TextField name="turnaround" label={LABELS.turnaround!} value={v.turnaround} error={e.turnaround} maxLength={200} />
          </Grid>
          <TextArea name="feeNote" label={LABELS.feeNote!} value={v.feeNote} error={e.feeNote} hint="When the fee varies, or to explain why it is not stated." />
          <TextField
            name="paymentChannel"
            label={LABELS.paymentChannel!}
            value={v.paymentChannel}
            error={e.paymentChannel}
            maxLength={300}
            hint="The channel, not an account number. The assistant never repeats bank details."
          />
        </Section>

        <Section title="How to do it">
          <TextArea
            name="requiredDocuments"
            label={LABELS.requiredDocuments!}
            value={v.requiredDocuments}
            error={e.requiredDocuments}
            rows={4}
            hint="One per line."
          />
          <TextArea name="steps" label={LABELS.steps!} value={v.steps} error={e.steps} rows={6} hint="One per line, in order. Numbered automatically." />
        </Section>

        <Provenance values={{ ...v, isPublished: v.isPublished !== '0' }} errors={e} />
      </FormPage>
    </Shell>,
    status,
  );
}

const Saved = ({ c }: { c: Context<Ctx> }) => {
  const s = c.req.query('saved');
  if (!s) return null;
  return (
    <div class="flash ok" role="status">
      <Icon name="check" /> {s === 'created' ? 'Service created.' : 'Saved.'} The assistant is already using it.
    </div>
  );
};
