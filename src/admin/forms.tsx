import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import type { Errors } from './validate';
import { Icon } from './layout';

/**
 * Form building blocks shared by every record type.
 *
 * Each field shows its own error beside it, keeps the submitted value,
 * and links label, hint and error for screen readers. An error summary at
 * the top lists every problem as a link to its field, so a long form
 * with one mistake near the bottom does not look like it silently failed.
 */

type Base = {
  name: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean;
};

function describedBy(name: string, hint?: string, error?: string): string | undefined {
  const ids = [hint ? `${name}-hint` : '', error ? `${name}-error` : ''].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

const Meta: FC<{ name: string; hint?: string | undefined; error?: string | undefined }> = ({ name, hint, error }) => (
  <>
    {hint ? (
      <div class="hint" id={`${name}-hint`}>
        {hint}
      </div>
    ) : null}
    {error ? (
      <div class="err" id={`${name}-error`}>
        <Icon name="alert" size={13} /> {error}
      </div>
    ) : null}
  </>
);

const Label: FC<{ name: string; label: string; required?: boolean | undefined }> = ({ name, label, required }) => (
  <label for={name}>
    {label}
    {required ? null : <span class="opt"> optional</span>}
  </label>
);

export const TextField: FC<
  Base & { value?: string | number | null | undefined; type?: string; maxLength?: number; placeholder?: string; inputmode?: 'decimal' | 'email' | 'numeric' | 'tel' | 'text' | 'url' }
> = ({ name, label, hint, error, required, value, type = 'text', maxLength, placeholder, inputmode }) => (
  <div class={`field${error ? ' has-error' : ''}`}>
    <Label name={name} label={label} required={required} />
    <input
      id={name}
      name={name}
      type={type}
      value={value ?? ''}
      required={required}
      maxlength={maxLength}
      placeholder={placeholder}
      inputmode={inputmode}
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={describedBy(name, hint, error)}
    />
    <Meta name={name} hint={hint} error={error} />
  </div>
);

export const TextArea: FC<Base & { value?: string | null | undefined; rows?: number; maxLength?: number }> = ({
  name,
  label,
  hint,
  error,
  required,
  value,
  rows = 3,
  maxLength,
}) => (
  <div class={`field${error ? ' has-error' : ''}`}>
    <Label name={name} label={label} required={required} />
    <textarea
      id={name}
      name={name}
      rows={rows}
      required={required}
      maxlength={maxLength}
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={describedBy(name, hint, error)}
    >
      {value ?? ''}
    </textarea>
    <Meta name={name} hint={hint} error={error} />
  </div>
);

export type Option = { value: string; label: string };

export const SelectField: FC<Base & { value?: string | null | undefined; options: Option[]; blank?: string }> = ({
  name,
  label,
  hint,
  error,
  required,
  value,
  options,
  blank,
}) => (
  <div class={`field${error ? ' has-error' : ''}`}>
    <Label name={name} label={label} required={required} />
    <select
      id={name}
      name={name}
      required={required}
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={describedBy(name, hint, error)}
    >
      {blank !== undefined ? <option value="">{blank}</option> : null}
      {options.map((o) => (
        <option value={o.value} selected={o.value === (value ?? '')}>
          {o.label}
        </option>
      ))}
    </select>
    <Meta name={name} hint={hint} error={error} />
  </div>
);

export const CheckboxField: FC<{ name: string; label: string; checked: boolean; hint?: string }> = ({
  name,
  label,
  checked,
  hint,
}) => (
  <div class="field check">
    <label class="check-label">
      <input type="checkbox" name={name} value="1" checked={checked} aria-describedby={hint ? `${name}-hint` : undefined} />
      <span>{label}</span>
    </label>
    {hint ? (
      <div class="hint" id={`${name}-hint`}>
        {hint}
      </div>
    ) : null}
  </div>
);

/** Lists every error at the top as a link to its field. */
export const ErrorSummary: FC<{ errors: Errors; labels: Record<string, string> }> = ({ errors, labels }) => {
  const keys = Object.keys(errors);
  if (keys.length === 0) return null;
  return (
    <div class="err-summary" role="alert" tabindex={-1} id="error-summary">
      <h2>
        <Icon name="alert" /> {keys.length === 1 ? 'There is a problem' : `There are ${keys.length} problems`} with
        this form
      </h2>
      <ul>
        {keys.map((k) => (
          <li>
            <a href={`#${k}`}>
              {/* Name the field only when the message does not already. */}
              {labels[k] && !errors[k]!.startsWith(labels[k]!) ? `${labels[k]}: ` : ''}
              {errors[k]}
            </a>
          </li>
        ))}
      </ul>
      <p class="t-dim" style="margin:6px 0 0">Nothing has been saved. Your entries are kept below.</p>
    </div>
  );
};

export const Section: FC<PropsWithChildren<{ title: string; note?: string }>> = ({ title, note, children }) => (
  <fieldset class="section">
    <legend>{title}</legend>
    {note ? <p class="section-note">{note}</p> : null}
    {children}
  </fieldset>
);

export const Grid: FC<PropsWithChildren> = ({ children }) => <div class="grid2">{children}</div>;

/**
 * Where a record came from and how sure we are of it. Identical on every
 * record type, because it is the same promise everywhere: a source, a
 * confidence level, and a named person who checked it.
 */
export const Provenance: FC<{
  values: { sourceUrl?: string | null; verifiedBy?: string | null; confidence?: string | null; isPublished?: boolean };
  errors: Errors;
  publishLabel?: string;
}> = ({ values, errors, publishLabel = 'Visible to users' }) => (
  <Section
    title="Source and confidence"
    note="Saving marks this record as verified today. Only choose Confirmed if a named officer confirmed it."
  >
    <SelectField
      name="confidence"
      label="Confidence"
      required
      value={values.confidence ?? 'unverified'}
      error={errors.confidence}
      options={[
        { value: 'confirmed', label: 'Confirmed — checked with a named officer' },
        { value: 'published', label: "Published — from the agency's own website or document" },
        { value: 'unverified', label: 'Unverified — from a secondary source' },
      ]}
    />
    <Grid>
      <TextField
        name="sourceUrl"
        label="Source URL"
        type="url"
        value={values.sourceUrl}
        error={errors.sourceUrl}
        placeholder="https://"
      />
      <TextField
        name="verifiedBy"
        label="Confirmed by"
        value={values.verifiedBy}
        error={errors.verifiedBy}
        hint="Name and role of the officer, if confirmed by phone or in person."
        maxLength={200}
      />
    </Grid>
    <CheckboxField
      name="isPublished"
      label={publishLabel}
      checked={values.isPublished ?? true}
      hint="Untick to withdraw this record from answers without deleting it. Records are never deleted, so the audit trail stays complete."
    />
  </Section>
);

export const FormPage: FC<{
  title: string;
  back: { href: string; label: string };
  action: string;
  submit: string;
  busy: string;
  errors: Errors;
  labels: Record<string, string>;
  footnote?: string | undefined;
  children: Child;
}> = ({ title, back, action, submit, busy, errors, labels, footnote, children }) => (
  <>
    <a class="btn ghost" href={back.href} style="margin-bottom:16px">
      <Icon name="back" /> {back.label}
    </a>
    <ErrorSummary errors={errors} labels={labels} />
    <form method="post" action={action} novalidate={Object.keys(errors).length > 0 ? true : undefined}>
      <div class="panel">
        <div class="panel-h">
          <h2>{title}</h2>
        </div>
        <div class="form-body">{children}</div>
        <div class="form-foot">
          <button class="btn primary" type="submit" data-busy-label={busy}>
            <Icon name="check" /> {submit}
          </button>
          <a class="btn ghost" href={back.href}>
            Cancel
          </a>
          {footnote ? <span class="t-dim" style="margin-left:auto">{footnote}</span> : null}
        </div>
      </div>
    </form>
  </>
);
