import { Hono, type Context } from 'hono';
import { asc, eq, sql } from 'drizzle-orm';
import { agencies, lgaEnum, services } from '../../db/schema';
import { audit, isUniqueViolation, type Ctx } from '../context';
import { canEdit } from '../access';
import { Form, uniqueSlug, type Errors } from '../validate';
import { FormPage, Grid, Provenance, Section, SelectField, TextArea, TextField } from '../forms';
import { ConfidenceBadge, Icon, Shell, formatDate } from '../layout';
import { isUuid } from './util';

/**
 * Agencies: ministries, boards and offices.
 *
 * Holds who leads each one and what it is responsible for, which answers
 * the commonest question a state assistant gets — "who do I talk to
 * about X?". It is also the record that goes stale fastest: every
 * reshuffle changes a head. So it is edited here, with every change in
 * the audit log, rather than shipped in code.
 */
export const agenciesAdmin = new Hono<Ctx>();

const LABELS: Record<string, string> = {
  name: 'Full name',
  shortName: 'Short name',
  headTitle: 'Head — title',
  headName: 'Head — name',
  responsibilities: 'Responsible for',
  address: 'Address',
  lga: 'LGA',
  hours: 'Opening hours',
  phone: 'Phone',
  email: 'Email',
  website: 'Website',
  latitude: 'Latitude',
  longitude: 'Longitude',
  sourceUrl: 'Source URL',
  verifiedBy: 'Confirmed by',
  confidence: 'Confidence',
};

/** Form values exactly as submitted; isPublished is '1' or '0', as the checkbox posts it. */
type Values = Record<string, string>;

agenciesAdmin.get('/', async (c) => {
  const rows = await c
    .get('db')
    .select({
      id: agencies.id,
      name: agencies.name,
      shortName: agencies.shortName,
      headTitle: agencies.headTitle,
      headName: agencies.headName,
      confidence: agencies.confidence,
      verifiedAt: agencies.verifiedAt,
      isPublished: agencies.isPublished,
      serviceCount: sql<number>`(select count(*)::int from ${services} where ${services.agencyId} = ${agencies.id})`,
    })
    .from(agencies)
    .orderBy(asc(agencies.name));

  return c.html(
    <Shell title="Agencies" path="/admin/agencies" user={c.get('user')}>
      <Saved c={c} />
      <div class="toolbar">
        <p class="lede" style="margin:0">
          Ministries and offices. The assistant answers "who handles this?" and "who heads that?" from here.
        </p>
        <span class="spacer" />
        {canEdit(c.get('user').role) ? (
          <a class="btn primary" href="/admin/agencies/new">
            <Icon name="plus" /> New agency
          </a>
        ) : null}
      </div>
      <div class="panel">
        {rows.length === 0 ? (
          <div class="empty">
            No agencies yet. {canEdit(c.get('user').role) ? <><a href="/admin/agencies/new">Add the first one</a>.</> : null}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agency</th>
                <th style="width:230px">Head</th>
                <th style="width:85px">Services</th>
                <th style="width:120px">Confidence</th>
                <th style="width:115px">Verified</th>
                <th style="width:70px"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr>
                  <td>
                    <div class="t-strong">
                      {a.name}
                      {!a.isPublished ? (
                        <span class="badge muted" style="margin-left:8px">
                          Hidden
                        </span>
                      ) : null}
                    </div>
                    {a.shortName ? <div class="t-dim">{a.shortName}</div> : null}
                  </td>
                  <td>
                    {a.headName ? (
                      <>
                        <div>{a.headName}</div>
                        <div class="t-dim">{a.headTitle}</div>
                      </>
                    ) : (
                      <span class="badge warn">
                        <span class="dot" />
                        Name not confirmed
                      </span>
                    )}
                  </td>
                  <td class="num">{a.serviceCount}</td>
                  <td>
                    <ConfidenceBadge value={a.confidence} />
                  </td>
                  <td class="num t-dim">{formatDate(a.verifiedAt)}</td>
                  <td>
                    <a class="btn sm" href={`/admin/agencies/${a.id}`}>
                      {canEdit(c.get('user').role) ? 'Edit' : 'View'}
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

agenciesAdmin.get('/new', (c) => renderForm(c, { mode: 'new', values: { confidence: 'unverified' }, errors: {} }));

agenciesAdmin.post('/new', async (c) => {
  const form = new Form(await c.req.formData());
  const data = parse(form);
  if (!form.ok) return renderForm(c, { mode: 'new', values: rawValues(form), errors: form.errors }, 422);

  const db = c.get('db');
  const slug = await uniqueSlug(data.shortName || data.name, async (s) =>
    (await db.select({ id: agencies.id }).from(agencies).where(eq(agencies.slug, s)).limit(1)).length > 0,
  );

  try {
    const [row] = await db.insert(agencies).values({ ...data, slug }).returning();
    await audit(c, 'create', 'agencies', row!.id, null, row);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    form.errors.name = 'An agency with this name already exists.';
    return renderForm(c, { mode: 'new', values: rawValues(form), errors: form.errors }, 422);
  }
  return c.redirect('/admin/agencies?saved=created');
});

agenciesAdmin.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return c.notFound();
  const [row] = await c.get('db').select().from(agencies).where(eq(agencies.id, id)).limit(1);
  if (!row) return c.notFound();

  return renderForm(c, {
    mode: 'edit',
    id,
    slug: row.slug,
    verifiedAt: row.verifiedAt,
    values: {
      name: row.name,
      shortName: row.shortName ?? '',
      headTitle: row.headTitle ?? '',
      headName: row.headName ?? '',
      responsibilities: row.responsibilities ?? '',
      address: row.address ?? '',
      lga: row.lga ?? '',
      hours: row.hours ?? '',
      phone: row.phone ?? '',
      email: row.email ?? '',
      website: row.website ?? '',
      latitude: row.latitude?.toString() ?? '',
      longitude: row.longitude?.toString() ?? '',
      sourceUrl: row.sourceUrl ?? '',
      verifiedBy: row.verifiedBy ?? '',
      confidence: row.confidence,
      isPublished: row.isPublished ? '1' : '0',
    },
    errors: {},
  });
});

agenciesAdmin.post('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return c.notFound();
  const db = c.get('db');
  const [before] = await db.select().from(agencies).where(eq(agencies.id, id)).limit(1);
  if (!before) return c.notFound();

  const form = new Form(await c.req.formData());
  const data = parse(form);
  const again = () =>
    renderForm(
      c,
      { mode: 'edit', id, slug: before.slug, verifiedAt: before.verifiedAt, values: rawValues(form), errors: form.errors },
      422,
    );
  if (!form.ok) return again();

  try {
    const [after] = await db.update(agencies).set(data).where(eq(agencies.id, id)).returning();
    await audit(c, 'update', 'agencies', id, before, after);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    form.errors.name = 'Another agency already has this name.';
    return again();
  }
  return c.redirect('/admin/agencies?saved=updated');
});

/* ------------------------------------------------------------------ */

function parse(form: Form) {
  const name = form.text('name', { required: true, max: 200, label: LABELS.name! });
  const { latitude, longitude } = form.coordinates();
  const confidence = form.oneOf('confidence', ['confirmed', 'published', 'unverified'] as const, {
    required: true,
    label: LABELS.confidence!,
  });
  return {
    name: name ?? '',
    shortName: form.text('shortName', { max: 32, label: LABELS.shortName! }),
    headTitle: form.text('headTitle', { max: 120, label: LABELS.headTitle! }),
    headName: form.text('headName', { max: 200, label: LABELS.headName! }),
    responsibilities: form.text('responsibilities', { max: 1500, label: LABELS.responsibilities! }),
    address: form.text('address', { max: 300, label: LABELS.address! }),
    lga: form.oneOf('lga', lgaEnum.enumValues, { label: LABELS.lga! }),
    hours: form.text('hours', { max: 120, label: LABELS.hours! }),
    phone: form.text('phone', { max: 32, label: LABELS.phone! }),
    email: form.email('email', LABELS.email!),
    website: form.url('website', LABELS.website!),
    latitude,
    longitude,
    sourceUrl: form.url('sourceUrl', LABELS.sourceUrl!),
    verifiedBy: form.text('verifiedBy', { max: 200, label: LABELS.verifiedBy! }),
    confidence: confidence ?? 'unverified',
    isPublished: form.checkbox('isPublished'),
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

function renderForm(
  c: Context<Ctx>,
  s: { mode: 'new' | 'edit'; id?: string; slug?: string | null; verifiedAt?: Date | null; values: Values; errors: Errors },
  status: 200 | 422 = 200,
) {
  const v = s.values;
  const e = s.errors;
  const isNew = s.mode === 'new';

  return c.html(
    <Shell title={isNew ? 'New agency' : v.name || 'Edit agency'} path="/admin/agencies" user={c.get('user')}>
      <FormPage
        readOnly={!canEdit(c.get('user').role)}
        title={isNew ? 'Add an agency' : 'Edit agency'}
        back={{ href: '/admin/agencies', label: 'All agencies' }}
        action={isNew ? '/admin/agencies/new' : `/admin/agencies/${s.id}`}
        submit={isNew ? 'Create agency' : 'Save changes'}
        busy={isNew ? 'Creating...' : 'Saving...'}
        errors={e}
        labels={LABELS}
        footnote={isNew ? undefined : `Last verified ${formatDate(s.verifiedAt ?? null)}`}
      >
        <Section title="Identity">
          <TextField name="name" label={LABELS.name!} required value={v.name} error={e.name} maxLength={200} hint='e.g. "Imo State Ministry of Youth and Sports Development".' />
          {s.slug ? <p class="slug" style="margin:-8px 0 14px">id: {s.slug}</p> : null}
          <TextField name="shortName" label={LABELS.shortName!} value={v.shortName} error={e.shortName} maxLength={32} hint='What people call it, e.g. "Ministry of Youth" or "IIRS".' />
        </Section>

        <Section
          title="Leadership and remit"
          note="Leave the head's name blank until it is confirmed. The assistant then says the name is not on record rather than guessing."
        >
          <Grid>
            <TextField name="headTitle" label={LABELS.headTitle!} value={v.headTitle} error={e.headTitle} maxLength={120} placeholder="Honourable Commissioner" />
            <TextField name="headName" label={LABELS.headName!} value={v.headName} error={e.headName} maxLength={200} />
          </Grid>
          <TextArea
            name="responsibilities"
            label={LABELS.responsibilities!}
            value={v.responsibilities}
            error={e.responsibilities}
            rows={4}
            maxLength={1500}
            hint="Plain language. This is what the assistant matches questions against — list the things people would actually ask about."
          />
        </Section>

        <Section title="Contact and location">
          <TextField name="address" label={LABELS.address!} value={v.address} error={e.address} maxLength={300} />
          <Grid>
            <SelectField
              name="lga"
              label={LABELS.lga!}
              value={v.lga}
              error={e.lga}
              blank="— Select —"
              options={lgaEnum.enumValues.map((l) => ({ value: l, label: l }))}
            />
            <TextField name="hours" label={LABELS.hours!} value={v.hours} error={e.hours} maxLength={120} placeholder="Mon–Fri, 8am–4pm" />
          </Grid>
          <Grid>
            <TextField name="phone" label={LABELS.phone!} type="tel" value={v.phone} error={e.phone} maxLength={32} inputmode="tel" />
            <TextField name="email" label={LABELS.email!} type="email" value={v.email} error={e.email} maxLength={160} inputmode="email" />
          </Grid>
          <TextField name="website" label={LABELS.website!} type="url" value={v.website} error={e.website} placeholder="https://" />
          <Grid>
            <TextField name="latitude" label={LABELS.latitude!} value={v.latitude} error={e.latitude} inputmode="decimal" placeholder="5.4836" />
            <TextField name="longitude" label={LABELS.longitude!} value={v.longitude} error={e.longitude} inputmode="decimal" placeholder="7.0333" hint="Both or neither. Used for the map link." />
          </Grid>
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
      <Icon name="check" /> {s === 'created' ? 'Agency created.' : 'Saved.'} The assistant is already using it.
    </div>
  );
};
