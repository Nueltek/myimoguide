import { Hono, type Context } from 'hono';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import { facilities, facilityTypeEnum, lgaEnum } from '../../db/schema';
import { audit, isUniqueViolation, type Ctx } from '../context';
import { Form, type Errors } from '../validate';
import { FormPage, Grid, Provenance, Section, SelectField, TextArea, TextField } from '../forms';
import { ConfidenceBadge, Icon, Shell, formatDate } from '../layout';
import { FACILITY_TYPE_LABELS, isUuid } from './util';

/**
 * Health and security facilities.
 *
 * The highest-stakes records in the system: a dead phone number for a
 * hospital is the one error here that can hurt someone. The list makes
 * stale records visible, and the form will not accept coordinates that
 * fall outside Imo State.
 */
export const facilitiesAdmin = new Hono<Ctx>();

const LABELS: Record<string, string> = {
  name: 'Name',
  type: 'Type',
  lga: 'LGA',
  address: 'Address',
  phone: 'Phone',
  altPhone: 'Second phone',
  isTwentyFourHour: 'Open 24 hours',
  latitude: 'Latitude',
  longitude: 'Longitude',
  notes: 'Notes',
  sourceUrl: 'Source URL',
  verifiedBy: 'Confirmed by',
  confidence: 'Confidence',
};

/** Records unchecked for longer than this are flagged in the list. */
const STALE_DAYS = 30;

/** Form values exactly as submitted; isPublished is '1' or '0', as the checkbox posts it. */
type Values = Record<string, string>;

facilitiesAdmin.get('/', async (c) => {
  const type = c.req.query('type');
  const lga = c.req.query('lga');
  const filters: SQL[] = [];
  if (type && (facilityTypeEnum.enumValues as readonly string[]).includes(type)) {
    filters.push(eq(facilities.type, type as (typeof facilityTypeEnum.enumValues)[number]));
  }
  if (lga && (lgaEnum.enumValues as readonly string[]).includes(lga)) {
    filters.push(eq(facilities.lga, lga as (typeof lgaEnum.enumValues)[number]));
  }

  const rows = await c
    .get('db')
    .select()
    .from(facilities)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(facilities.lga), asc(facilities.name))
    .limit(500);

  const staleBefore = Date.now() - STALE_DAYS * 86_400_000;

  return c.html(
    <Shell title="Facilities" path="/admin/facilities" email={c.get('user').email}>
      <Saved c={c} />
      <form class="toolbar" method="get" action="/admin/facilities">
        <select name="type" aria-label="Filter by type">
          <option value="">All types</option>
          {facilityTypeEnum.enumValues.map((t) => (
            <option value={t} selected={t === type}>
              {FACILITY_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select name="lga" aria-label="Filter by LGA">
          <option value="">All LGAs</option>
          {lgaEnum.enumValues.map((l) => (
            <option value={l} selected={l === lga}>
              {l}
            </option>
          ))}
        </select>
        <button class="btn" type="submit">
          Filter
        </button>
        {type || lga ? (
          <a class="btn ghost" href="/admin/facilities">
            Clear
          </a>
        ) : null}
        <span class="spacer" />
        <a class="btn primary" href="/admin/facilities/new">
          <Icon name="plus" /> New facility
        </a>
      </form>

      <div class="panel">
        <div class="panel-h">
          <div>
            <h2>{rows.length === 1 ? '1 facility' : `${rows.length} facilities`}</h2>
            <p>Phone numbers here are given to people in emergencies. Anything unchecked for {STALE_DAYS} days is flagged.</p>
          </div>
        </div>
        {rows.length === 0 ? (
          <div class="empty">
            {type || lga ? 'No facilities match this filter.' : 'No facilities yet.'}{' '}
            <a href="/admin/facilities/new">Add one</a>.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Facility</th>
                <th style="width:160px">Type</th>
                <th style="width:150px">LGA</th>
                <th style="width:140px">Phone</th>
                <th style="width:120px">Confidence</th>
                <th style="width:125px">Verified</th>
                <th style="width:70px"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const stale = !f.verifiedAt || f.verifiedAt.getTime() < staleBefore;
                return (
                  <tr>
                    <td>
                      <div class="t-strong">
                        {f.name}
                        {!f.isPublished ? (
                          <span class="badge muted" style="margin-left:8px">
                            Hidden
                          </span>
                        ) : null}
                      </div>
                      <div class="t-dim clip">{f.address}</div>
                    </td>
                    <td class="t-dim">{FACILITY_TYPE_LABELS[f.type]}</td>
                    <td class="t-dim">{f.lga}</td>
                    <td class="num">{f.phone ?? <span class="badge bad">No phone</span>}</td>
                    <td>
                      <ConfidenceBadge value={f.confidence} />
                    </td>
                    <td class="num">
                      {stale ? (
                        <span class="badge warn" title={`Not checked in the last ${STALE_DAYS} days`}>
                          <span class="dot" />
                          {f.verifiedAt ? formatDate(f.verifiedAt) : 'Never'}
                        </span>
                      ) : (
                        <span class="t-dim">{formatDate(f.verifiedAt)}</span>
                      )}
                    </td>
                    <td>
                      <a class="btn sm" href={`/admin/facilities/${f.id}`}>
                        Edit
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Shell>,
  );
});

facilitiesAdmin.get('/new', (c) =>
  renderForm(c, { mode: 'new', values: { confidence: 'unverified', isTwentyFourHour: '' }, errors: {} }),
);

facilitiesAdmin.post('/new', async (c) => {
  const form = new Form(await c.req.formData());
  const data = parse(form);
  if (!form.ok) return renderForm(c, { mode: 'new', values: rawValues(form), errors: form.errors }, 422);

  try {
    const [row] = await c.get('db').insert(facilities).values(data).returning();
    await audit(c, 'create', 'facilities', row!.id, null, row);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    form.errors.name = 'A facility with this name already exists in this LGA.';
    return renderForm(c, { mode: 'new', values: rawValues(form), errors: form.errors }, 422);
  }
  return c.redirect('/admin/facilities?saved=created');
});

facilitiesAdmin.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return c.notFound();
  const [row] = await c.get('db').select().from(facilities).where(eq(facilities.id, id)).limit(1);
  if (!row) return c.notFound();

  return renderForm(c, {
    mode: 'edit',
    id,
    verifiedAt: row.verifiedAt,
    values: {
      name: row.name,
      type: row.type,
      lga: row.lga,
      address: row.address,
      phone: row.phone ?? '',
      altPhone: row.altPhone ?? '',
      isTwentyFourHour: row.isTwentyFourHour === null ? '' : row.isTwentyFourHour ? 'yes' : 'no',
      latitude: row.latitude?.toString() ?? '',
      longitude: row.longitude?.toString() ?? '',
      notes: row.notes ?? '',
      sourceUrl: row.sourceUrl ?? '',
      verifiedBy: row.verifiedBy ?? '',
      confidence: row.confidence,
      isPublished: row.isPublished ? '1' : '0',
    },
    errors: {},
  });
});

facilitiesAdmin.post('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return c.notFound();
  const db = c.get('db');
  const [before] = await db.select().from(facilities).where(eq(facilities.id, id)).limit(1);
  if (!before) return c.notFound();

  const form = new Form(await c.req.formData());
  const data = parse(form);
  const again = () =>
    renderForm(c, { mode: 'edit', id, verifiedAt: before.verifiedAt, values: rawValues(form), errors: form.errors }, 422);
  if (!form.ok) return again();

  try {
    const [after] = await db.update(facilities).set(data).where(eq(facilities.id, id)).returning();
    await audit(c, 'update', 'facilities', id, before, after);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    form.errors.name = 'Another facility in this LGA already has this name.';
    return again();
  }
  return c.redirect('/admin/facilities?saved=updated');
});

/* ------------------------------------------------------------------ */

function parse(form: Form) {
  const name = form.text('name', { required: true, max: 200, label: LABELS.name! });
  const type = form.oneOf('type', facilityTypeEnum.enumValues, { required: true, label: LABELS.type! });
  const lga = form.oneOf('lga', lgaEnum.enumValues, { required: true, label: LABELS.lga! });
  const address = form.text('address', { required: true, max: 300, label: LABELS.address! });
  const allDay = form.oneOf('isTwentyFourHour', ['yes', 'no'] as const, { label: LABELS.isTwentyFourHour! });
  const { latitude, longitude } = form.coordinates();
  const confidence = form.oneOf('confidence', ['confirmed', 'published', 'unverified'] as const, {
    required: true,
    label: LABELS.confidence!,
  });

  return {
    name: name ?? '',
    // Placeholders only reach the database if validation passed, in
    // which case the real values are set; the casts satisfy the types.
    type: (type ?? 'hospital') as (typeof facilityTypeEnum.enumValues)[number],
    lga: (lga ?? 'Owerri Municipal') as (typeof lgaEnum.enumValues)[number],
    address: address ?? '',
    phone: form.text('phone', { max: 32, label: LABELS.phone! }),
    altPhone: form.text('altPhone', { max: 32, label: LABELS.altPhone! }),
    // Unknown is a real answer, distinct from "no". The assistant only
    // claims 24-hour service when someone has said yes.
    isTwentyFourHour: allDay === null ? null : allDay === 'yes',
    latitude,
    longitude,
    notes: form.text('notes', { max: 1000, label: LABELS.notes! }),
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
  s: { mode: 'new' | 'edit'; id?: string; verifiedAt?: Date | null; values: Values; errors: Errors },
  status: 200 | 422 = 200,
) {
  const v = s.values;
  const e = s.errors;
  const isNew = s.mode === 'new';

  return c.html(
    <Shell title={isNew ? 'New facility' : v.name || 'Edit facility'} path="/admin/facilities" email={c.get('user').email}>
      <FormPage
        title={isNew ? 'Add a facility' : 'Edit facility'}
        back={{ href: '/admin/facilities', label: 'All facilities' }}
        action={isNew ? '/admin/facilities/new' : `/admin/facilities/${s.id}`}
        submit={isNew ? 'Create facility' : 'Save changes'}
        busy={isNew ? 'Creating...' : 'Saving...'}
        errors={e}
        labels={LABELS}
        footnote={isNew ? undefined : `Last verified ${formatDate(s.verifiedAt ?? null)}`}
      >
        <Section title="What and where">
          <TextField name="name" label={LABELS.name!} required value={v.name} error={e.name} maxLength={200} />
          <Grid>
            <SelectField
              name="type"
              label={LABELS.type!}
              required
              value={v.type}
              error={e.type}
              blank="— Select —"
              options={facilityTypeEnum.enumValues.map((t) => ({ value: t, label: FACILITY_TYPE_LABELS[t]! }))}
            />
            <SelectField
              name="lga"
              label={LABELS.lga!}
              required
              value={v.lga}
              error={e.lga}
              blank="— Select —"
              options={lgaEnum.enumValues.map((l) => ({ value: l, label: l }))}
            />
          </Grid>
          <TextField name="address" label={LABELS.address!} required value={v.address} error={e.address} maxLength={300} />
          <Grid>
            <TextField name="latitude" label={LABELS.latitude!} value={v.latitude} error={e.latitude} inputmode="decimal" placeholder="5.4836" />
            <TextField name="longitude" label={LABELS.longitude!} value={v.longitude} error={e.longitude} inputmode="decimal" placeholder="7.0333" hint="Both or neither. Gives the user a map link." />
          </Grid>
        </Section>

        <Section title="Reaching it" note="These numbers are given to people in emergencies. Ring them before you save.">
          <Grid>
            <TextField name="phone" label={LABELS.phone!} type="tel" value={v.phone} error={e.phone} maxLength={32} inputmode="tel" />
            <TextField name="altPhone" label={LABELS.altPhone!} type="tel" value={v.altPhone} error={e.altPhone} maxLength={32} inputmode="tel" />
          </Grid>
          <SelectField
            name="isTwentyFourHour"
            label={LABELS.isTwentyFourHour!}
            value={v.isTwentyFourHour}
            error={e.isTwentyFourHour}
            blank="Not known"
            options={[
              { value: 'yes', label: 'Yes — open 24 hours' },
              { value: 'no', label: 'No — set hours' },
            ]}
            hint="Leave as Not known unless confirmed. The assistant only claims 24-hour service on a yes."
          />
          <TextArea name="notes" label={LABELS.notes!} value={v.notes} error={e.notes} hint="Anything a visitor should know — entrance, departments, landmarks." />
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
      <Icon name="check" /> {s === 'created' ? 'Facility created.' : 'Saved.'}
    </div>
  );
};
