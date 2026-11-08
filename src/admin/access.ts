/**
 * Who may do what in the dashboard.
 *
 * One table of rules, checked once in the middleware for every request.
 * A page added later is covered by these rules without anyone remembering
 * to protect it, and an unrecognised role can do nothing.
 *
 *   Administrator  Everything, including managing accounts. A ministry
 *                  should always have at least two, so that one can
 *                  recover the other.
 *   Editor         Adds and updates services, agencies, facilities and
 *                  facts. Most staff.
 *   Viewer         Reads everything, changes nothing. For a commissioner,
 *                  an auditor, or a reviewer from another ministry.
 *
 * Everyone, whatever their role, can manage their own account: their own
 * password, recovery codes and sessions.
 */

export const ROLES = ['administrator', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  administrator: 'Administrator',
  editor: 'Editor',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  administrator: 'Everything an editor can do, plus inviting people, changing roles and removing access.',
  editor: 'Adds and updates services, agencies, facilities and facts. Cannot manage accounts.',
  viewer: 'Can see everything, including questions and the audit log. Cannot change anything.',
};

/** "an Administrator", "an Editor", "a Viewer". */
export const withArticle = (role: Role) => `${role === 'viewer' ? 'a' : 'an'} ${ROLE_LABELS[role]}`;

export function asRole(value: string | null | undefined): Role | null {
  return (ROLES as readonly string[]).includes(value ?? '') ? (value as Role) : null;
}

/** Paths every signed-in person may post to, whatever their role. */
const SELF_SERVICE = ['/admin/logout', '/admin/account', '/admin/confirm'];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export function permits(role: string, method: string, path: string): boolean {
  const r = asRole(role);
  if (!r) return path === '/admin/logout';

  if (under(path, '/admin/users')) return r === 'administrator';
  // A blank form is only useful to someone who can submit it.
  if (path.endsWith('/new')) return r !== 'viewer';
  if (method === 'GET' || method === 'HEAD') return true;
  if (SELF_SERVICE.some((p) => under(path, p))) return true;
  return r !== 'viewer';
}

/** May this person change published records? Used to show or hide edit controls. */
export const canEdit = (role: string) => {
  const r = asRole(role);
  return r === 'administrator' || r === 'editor';
};

/**
 * Actions that need the second factor to have been given recently, not
 * just at sign-in up to eight hours ago. Managing accounts can grant
 * access to someone else; new recovery codes are a way into this account.
 * Either, from a laptop left unlocked, would outlive the moment.
 */
export const CONFIRM_WINDOW_MINUTES = 15;

export function needsConfirmation(method: string, path: string): boolean {
  if (under(path, '/admin/users')) return true;
  return method === 'POST' && path === '/admin/account/recovery-codes';
}

export function isFresh(confirmedAt: Date | null, now = Date.now()): boolean {
  return confirmedAt !== null && now - confirmedAt.getTime() < CONFIRM_WINDOW_MINUTES * 60_000;
}

/**
 * Where to go after confirming. Only a path inside the dashboard, so the
 * confirm page cannot be used to bounce someone to another site.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/admin') || value.startsWith('//') || /[\\\s]/.test(value)) return '/admin';
  if (value.startsWith('/admin/confirm') || value.startsWith('/admin/login')) return '/admin';
  return value;
}

/**
 * After a POST is interrupted to confirm, return to the page the form was
 * on, not to the POST address itself, which has no page.
 */
export function returnPathFor(method: string, path: string): string {
  if (method === 'GET') return path;
  const user = /^\/admin\/users\/([0-9a-f-]{36})\//.exec(path);
  if (user) return `/admin/users/${user[1]}`;
  if (under(path, '/admin/users')) return '/admin/users';
  if (under(path, '/admin/account')) return '/admin/account';
  return '/admin';
}
