/**
 * Form parsing and validation for the dashboard.
 *
 * Every rule is server-side. The browser's `required` and `type="email"`
 * attributes are a convenience for the person typing, never the control
 * — anything can POST to these routes.
 *
 * A failed save re-renders the form with the submitted values and an
 * error beside each field, rather than throwing. Typing a long service
 * description and losing it to one bad URL is the kind of thing that
 * makes staff stop trusting a system.
 */

export type Errors = Record<string, string>;

export class Form {
  readonly errors: Errors = {};
  constructor(private readonly data: FormData) {}

  /** Raw submitted value, trimmed. Used to re-fill the form on error. */
  raw(name: string): string {
    return String(this.data.get(name) ?? '').trim();
  }

  private fail(name: string, message: string): void {
    if (!this.errors[name]) this.errors[name] = message;
  }

  text(name: string, opts: { required?: boolean; max?: number; label: string }): string | null {
    const v = this.raw(name);
    if (!v) {
      if (opts.required) this.fail(name, `${opts.label} is required.`);
      return null;
    }
    if (opts.max && v.length > opts.max) {
      this.fail(name, `${opts.label} must be ${opts.max} characters or fewer (currently ${v.length}).`);
    }
    return v;
  }

  /** One item per line; blank lines dropped. */
  lines(name: string, opts: { maxItems?: number; label: string } = { label: 'This list' }): string[] {
    const items = this.raw(name)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (opts.maxItems && items.length > opts.maxItems) {
      this.fail(name, `${opts.label} can have at most ${opts.maxItems} entries.`);
    }
    return items;
  }

  /** Comma- or line-separated, for aliases. */
  list(name: string): string[] {
    return this.raw(name)
      .split(/[\n,]/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  number(name: string, opts: { min?: number; max?: number; label: string }): number | null {
    const v = this.raw(name);
    if (!v) return null;
    // Accept "15,000" and "₦15,000" — that is how fees are written here.
    const n = Number(v.replace(/[₦,\s]/g, ''));
    if (!Number.isFinite(n)) {
      this.fail(name, `${opts.label} must be a number.`);
      return null;
    }
    if (opts.min !== undefined && n < opts.min) this.fail(name, `${opts.label} must be at least ${opts.min}.`);
    if (opts.max !== undefined && n > opts.max) this.fail(name, `${opts.label} must be at most ${opts.max}.`);
    return n;
  }

  oneOf<T extends string>(
    name: string,
    allowed: readonly T[],
    opts: { required?: boolean; label: string },
  ): T | null {
    const v = this.raw(name);
    if (!v) {
      // Same wording as text fields. "Choose a lga." was the previous
      // attempt at a friendlier phrasing — wrong case, wrong article.
      if (opts.required) this.fail(name, `${opts.label} is required.`);
      return null;
    }
    if (!(allowed as readonly string[]).includes(v)) {
      this.fail(name, `${opts.label} is not one of the allowed values.`);
      return null;
    }
    return v as T;
  }

  url(name: string, label: string): string | null {
    const v = this.raw(name);
    if (!v) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
      return v;
    } catch {
      this.fail(name, `${label} must be a full web address starting with https://`);
      return null;
    }
  }

  email(name: string, label: string): string | null {
    const v = this.raw(name);
    if (!v) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 160) {
      this.fail(name, `${label} does not look like an email address.`);
      return null;
    }
    return v.toLowerCase();
  }

  checkbox(name: string): boolean {
    return this.data.get(name) === '1';
  }

  /**
   * Coordinates, checked against Imo State.
   *
   * Swapped latitude and longitude is the commonest data-entry error with
   * coordinates, and it puts a hospital in the Sahara. Values outside a
   * padded box around the state are rejected with that hint.
   */
  coordinates(): { latitude: number | null; longitude: number | null } {
    const latitude = this.number('latitude', { min: -90, max: 90, label: 'Latitude' });
    const longitude = this.number('longitude', { min: -180, max: 180, label: 'Longitude' });

    if ((latitude === null) !== (longitude === null)) {
      this.fail(latitude === null ? 'latitude' : 'longitude', 'Give both latitude and longitude, or neither.');
      return { latitude: null, longitude: null };
    }
    if (latitude !== null && longitude !== null && !this.errors.latitude && !this.errors.longitude) {
      const inImo = latitude >= 4.9 && latitude <= 6.2 && longitude >= 6.4 && longitude <= 7.7;
      if (!inImo) {
        const swapped = longitude >= 4.9 && longitude <= 6.2 && latitude >= 6.4 && latitude <= 7.7;
        this.fail(
          'latitude',
          swapped
            ? 'These look swapped — latitude for Imo State is around 5.5, longitude around 7.0.'
            : 'These coordinates are outside Imo State (latitude about 5.1–6.0, longitude about 6.6–7.5).',
        );
      }
    }
    return { latitude, longitude };
  }

  get ok(): boolean {
    return Object.keys(this.errors).length === 0;
  }
}

/** "Ministry of Youth & Sports" -> "ministry-of-youth-sports" */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Appends -2, -3... until `taken` says the slug is free. */
export async function uniqueSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base) || 'item';
  if (!(await taken(root))) return root;
  for (let i = 2; i < 100; i++) {
    const candidate = `${root}-${i}`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${root}-${crypto.randomUUID().slice(0, 8)}`;
}
