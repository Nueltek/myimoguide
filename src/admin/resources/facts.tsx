import { Hono, type Context } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { factCategoryEnum, stateFacts } from '../../db/schema';
import { audit, isUniqueViolation, type Ctx } from '../context';
import { Form, uniqueSlug, type Errors } from '../validate';
import { FormPage, Grid, Provenance, Section, SelectField, TextArea, TextField } from '../forms';
import { ConfidenceBadge, Icon, Shell, formatDate } from '../layout';
import { FACT_CATEGORY_LABELS, isUuid } from './util';

/**
 * State facts: general knowledge about Imo State.
 *
 * Each answer is written by a person from a cited source and sent to the
 * user verbatim. The model only picks which fact to return; it never
 * writes one. That is what keeps "who is the governor?" from being
 * answered out of a model's memory, which may be a year out of date.
 */
export const factsAdmin = new Hono<Ctx>();

const LABELS: Record<string, string> = {
  topic: 'Topic',
  answer: 'Answer',
  category: 'Category',
  aliases: 'Other ways people ask',
  sourceUrl: 'Source URL',
  verifiedBy: 'Confirmed by',
  confidence: 'Confidence',
};

/** Form values exactly as submitted; isPublished is '1' or '0', as the checkbox posts it. */
type Values = Record<string, string>;

factsAdmin.get('/', async (c) => {
  const rows = await c.get('db').select().from(stateFacts).orderBy(asc(stateFacts.category), asc(stateFacts.topic));

  return c.html(
    <Shell title="State facts" path="/admin/facts" email={c.get('user').email}>
      <Saved c={c} />
      <div class="toolbar">
        <p class="lede" style="margin:0">
          General knowledge, sent to users word for word. Open-ended questions go to web search instead.
        </p>
        <span class="spacer" />
        <a class="btn primary" href="/admin/facts/new">
          <Icon name="plus" /> New fact
        </a>
      </div>
      <div class="panel">
        {rows.length === 0 ? (
          <div class="empty">
            No facts yet. <a href="/admin/facts/new">Add the first one</a>.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style="width:230px">Topic</th>
                <th>Answer</th>
                <th style="width:120px">Category</th>
                <th style="width:120px">Confidence</th>
                <th style="width:115px">Verified</th>
                <th style="width:70px"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr>
                  <td class="t-strong">
                    {f.topic}
                    {!f.isPublished ? (
                      <span class="badge muted" style="margin-left:8px">
                        Hidden
                      </span>
                    ) : null}
                  </td>
                  <td class="t-dim">
                    <div class="clip">{f.answer.replace(/\*/g, '')}</div>
                  </td>
                  <td class="t-dim">{FACT_CATEGORY_LABELS[f.category]}</td>
                  <td>
                    <ConfidenceBadge value={f.confidence} />
                  </td>
                  <td class="num t-dim">{formatDate(f.verifiedAt)}</td>
                  <td>
                    <a class="btn sm" href={`/admin/facts/${f.id}`}>
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

factsAdmin.get('/new', (c) => renderForm(c, { mode: 'new', values: { confidence: 'unverified' }, errors: {} }));

factsAdmin.post('/new', async (c) => {
  const form = new Form(await c.req.formData());
  const data = parse(form);
  if (!form.ok) return renderForm(c, { mode: 'new', values: rawValues(form), errors: form.errors }, 422);

  const db = c.get('db');
  const slug = await uniqueSlug(data.topic, async (s) =>
    (await db.select({ id: stateFacts.id }).from(stateFacts).where(eq(stateFacts.slug, s)).limit(1)).length > 0,
  );

  try {
    const [row] = await db.insert(stateFacts).values({ ...data, slug }).returning();
    await audit(c, 'create', 'state_facts', row!.id, null, row);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    form.errors.topic = 'A fact with this topic already exists.';
    return renderForm(c, { mode: 'new', values: rawValues(form), errors: form.errors }, 422);
  }
  return c.redirect('/admin/facts?saved=created');
});

factsAdmin.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return c.notFound();
  const [row] = await c.get('db').select().from(stateFacts).where(eq(stateFacts.id, id)).limit(1);
  if (!row) return c.notFound();

  return renderForm(c, {
    mode: 'edit',
    id,
    slug: row.slug,
    verifiedAt: row.verifiedAt,
    values: {
      topic: row.topic,
      answer: row.answer,
      category: row.category,
      aliases: row.aliases.join(', '),
      sourceUrl: row.sourceUrl ?? '',
      verifiedBy: row.verifiedBy ?? '',
      confidence: row.confidence,
      isPublished: row.isPublished ? '1' : '0',
    },
    errors: {},
  });
});

factsAdmin.post('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return c.notFound();
  const db = c.get('db');
  const [before] = await db.select().from(stateFacts).where(eq(stateFacts.id, id)).limit(1);
  if (!before) return c.notFound();

  const form = new Form(await c.req.formData());
  const data = parse(form);
  if (!form.ok) {
    return renderForm(
      c,
      { mode: 'edit', id, slug: before.slug, verifiedAt: before.verifiedAt, values: rawValues(form), errors: form.errors },
      422,
    );
  }

  // The slug is never changed on edit: the router refers to facts by it.
  const [after] = await db.update(stateFacts).set(data).where(eq(stateFacts.id, id)).returning();
  await audit(c, 'update', 'state_facts', id, before, after);
  return c.redirect('/admin/facts?saved=updated');
});

/* ------------------------------------------------------------------ */

function parse(form: Form) {
  const topic = form.text('topic', { required: true, max: 200, label: LABELS.topic! });
  const answer = form.text('answer', { required: true, max: 2000, label: LABELS.answer! });
  const category = form.oneOf('category', factCategoryEnum.enumValues, { required: true, label: LABELS.category! });
  const confidence = form.oneOf('confidence', ['confirmed', 'published', 'unverified'] as const, {
    required: true,
    label: LABELS.confidence!,
  });
  return {
    topic: topic ?? '',
    answer: answer ?? '',
    category: (category ?? 'history') as (typeof factCategoryEnum.enumValues)[number],
    aliases: form.list('aliases').slice(0, 20),
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
  s: { mode: 'new' | 'edit'; id?: string; slug?: string; verifiedAt?: Date | null; values: Values; errors: Errors },
  status: 200 | 422 = 200,
) {
  const v = s.values;
  const e = s.errors;
  const isNew = s.mode === 'new';

  return c.html(
    <Shell title={isNew ? 'New fact' : v.topic || 'Edit fact'} path="/admin/facts" email={c.get('user').email}>
      <FormPage
        title={isNew ? 'Add a state fact' : 'Edit state fact'}
        back={{ href: '/admin/facts', label: 'All facts' }}
        action={isNew ? '/admin/facts/new' : `/admin/facts/${s.id}`}
        submit={isNew ? 'Create fact' : 'Save changes'}
        busy={isNew ? 'Creating...' : 'Saving...'}
        errors={e}
        labels={LABELS}
        footnote={isNew ? undefined : `Last verified ${formatDate(s.verifiedAt ?? null)}`}
      >
        <Section title="The question it answers">
          <TextField
            name="topic"
            label={LABELS.topic!}
            required
            value={v.topic}
            error={e.topic}
            maxLength={200}
            hint='Describe the question, e.g. "who the current governor of Imo State is". The assistant matches questions against this.'
          />
          {s.slug ? <p class="slug" style="margin:-8px 0 14px">id: {s.slug} — fixed, the assistant refers to the fact by it</p> : null}
          <Grid>
            <SelectField
              name="category"
              label={LABELS.category!}
              required
              value={v.category}
              error={e.category}
              blank="— Select —"
              options={factCategoryEnum.enumValues.map((k) => ({ value: k, label: FACT_CATEGORY_LABELS[k]! }))}
            />
            <TextField name="aliases" label={LABELS.aliases!} value={v.aliases} error={e.aliases} hint="Comma-separated, e.g. governor, who runs Imo." />
          </Grid>
        </Section>

        <Section title="The answer" note="Sent to the user word for word. Keep it short; the source and date are added automatically.">
          <TextArea
            name="answer"
            label={LABELS.answer!}
            required
            value={v.answer}
            error={e.answer}
            rows={6}
            maxLength={2000}
            hint="WhatsApp formatting works: *bold*, _italic_. One fact per record."
          />
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
      <Icon name="check" /> {s === 'created' ? 'Fact created.' : 'Saved.'} The assistant is already using it.
    </div>
  );
};
