import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';

/**
 * The dashboard shell and its design system.
 *
 * Built for a government buyer, which sets the constraints:
 *
 *  - Institutional, not consumer. Nigerian green as the single accent,
 *    on a near-white ground. No gradients, no glass, no colour used for
 *    decoration — every coloured element means something.
 *  - Icons, never emoji. Inline SVG, stroked, one weight throughout.
 *  - Motion is feedback, not ornament: 140ms, only on interaction.
 *  - Data first. Tight tables, tabular figures, nothing that pushes
 *    content below the fold to make room for styling.
 *
 * Server-rendered with no client framework. The page arrives complete,
 * which matters on a 3G connection in Owerri far more than hydration
 * does, and it keeps the whole system in one Worker and one deploy.
 *
 * On colour: Nigeria's national green (#008751) is the anchor. I could
 * not verify a distinct Imo State palette from an official source — if
 * the state has brand guidance, the tokens below are the only place to
 * change.
 */

const CSS = `
:root {
  --green-900:#00351F; --green-700:#005A36; --green-600:#008751; --green-50:#EBF5F0;
  --ink-900:#121614; --ink-700:#39413C; --ink-500:#67706A; --ink-300:#A3ABA6;
  --line:#E2E6E3; --line-strong:#CBD2CD;
  --surface:#FFFFFF; --canvas:#F7F9F8;
  --amber-600:#9A6700; --amber-50:#FFF8E6;
  --red-600:#B42318; --red-50:#FEF3F2;
  --radius:6px;
  --shadow:0 1px 2px rgba(18,22,20,.06), 0 1px 3px rgba(18,22,20,.04);
  --t:140ms cubic-bezier(.2,0,.2,1);
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink-900);
  font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
a{color:var(--green-700);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{margin:0;font-weight:600;letter-spacing:-.011em}
h1{font-size:20px} h2{font-size:16px} h3{font-size:14px}

.shell{display:grid;grid-template-columns:232px 1fr;min-height:100vh}
.side{background:var(--green-900);color:#fff;padding:20px 14px;display:flex;flex-direction:column;gap:28px}
.brand{display:flex;align-items:center;gap:10px;padding:0 8px}
.brand-mark{width:28px;height:28px;border-radius:5px;background:var(--green-600);
  display:grid;place-items:center;flex:none}
.brand-name{font-weight:600;font-size:14px;letter-spacing:-.01em}
.brand-sub{font-size:11px;color:rgba(255,255,255,.55);margin-top:1px}
.nav{display:flex;flex-direction:column;gap:1px}
.nav a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--radius);
  color:rgba(255,255,255,.72);font-size:13.5px;transition:background var(--t),color var(--t)}
.nav a:hover{background:rgba(255,255,255,.07);color:#fff;text-decoration:none}
.nav a[aria-current="page"]{background:rgba(255,255,255,.12);color:#fff;font-weight:500}
.side-foot{margin-top:auto;font-size:11.5px;color:rgba(255,255,255,.45);padding:0 8px;line-height:1.45}

.main{display:flex;flex-direction:column;min-width:0}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:14px 28px;background:var(--surface);border-bottom:1px solid var(--line)}
.top-meta{font-size:12.5px;color:var(--ink-500)}
.content{padding:24px 28px 56px;max-width:1160px;width:100%}
.lede{color:var(--ink-500);font-size:13.5px;margin:5px 0 0}

.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin:20px 0 26px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px}
.card-k{font-size:11.5px;text-transform:uppercase;letter-spacing:.055em;color:var(--ink-500);font-weight:500}
.card-v{font-size:25px;font-weight:600;margin-top:5px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.card-n{font-size:12px;color:var(--ink-500);margin-top:2px}

.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.panel-h{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:13px 16px;border-bottom:1px solid var(--line)}
.panel-h p{margin:3px 0 0;font-size:12.5px;color:var(--ink-500)}

table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-weight:500;font-size:11.5px;text-transform:uppercase;letter-spacing:.055em;
  color:var(--ink-500);padding:9px 16px;border-bottom:1px solid var(--line);background:var(--canvas)}
td{padding:11px 16px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr{transition:background var(--t)}
tbody tr:hover{background:var(--green-50)}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.t-strong{font-weight:500}
.t-dim{color:var(--ink-500);font-size:12.5px}

.badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;
  font-size:11.5px;font-weight:500;white-space:nowrap;border:1px solid transparent}
.badge.ok{background:var(--green-50);color:var(--green-700);border-color:#CBE5D8}
.badge.warn{background:var(--amber-50);color:var(--amber-600);border-color:#F2E3BC}
.badge.muted{background:#F1F3F2;color:var(--ink-500);border-color:var(--line-strong)}
.badge.bad{background:var(--red-50);color:var(--red-600);border-color:#F6CFCB}
.dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}

.btn{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:var(--radius);
  border:1px solid var(--line-strong);background:var(--surface);color:var(--ink-900);
  font-size:13.5px;font-weight:500;cursor:pointer;font-family:inherit;
  transition:background var(--t),border-color var(--t),box-shadow var(--t)}
.btn:hover{background:var(--canvas);border-color:var(--ink-300);text-decoration:none}
.btn:active{transform:translateY(.5px)}
.btn.primary{background:var(--green-600);border-color:var(--green-600);color:#fff}
.btn.primary:hover{background:var(--green-700);border-color:var(--green-700)}
.btn:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{
  outline:2px solid var(--green-600);outline-offset:2px}

label{display:block;font-size:12.5px;font-weight:500;color:var(--ink-700);margin-bottom:5px}
.hint{font-size:12px;color:var(--ink-500);font-weight:400;margin-top:4px}
input[type=text],input[type=email],input[type=password],input[type=number],textarea,select{
  width:100%;padding:8px 10px;border:1px solid var(--line-strong);border-radius:var(--radius);
  font:inherit;font-size:13.5px;background:var(--surface);color:var(--ink-900);
  transition:border-color var(--t),box-shadow var(--t)}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--green-600);
  box-shadow:0 0 0 3px rgba(0,135,81,.12)}
textarea{min-height:76px;resize:vertical;line-height:1.5}
.field{margin-bottom:16px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.form-foot{display:flex;gap:10px;align-items:center;padding:14px 16px;
  border-top:1px solid var(--line);background:var(--canvas)}

.flash{padding:10px 14px;border-radius:var(--radius);font-size:13.5px;margin-bottom:18px;
  border:1px solid transparent}
.flash.ok{background:var(--green-50);color:var(--green-700);border-color:#CBE5D8}
.flash.bad{background:var(--red-50);color:var(--red-600);border-color:#F6CFCB}

.empty{padding:40px 20px;text-align:center;color:var(--ink-500);font-size:13.5px}

.login{min-height:100vh;display:grid;place-items:center;background:var(--canvas);padding:20px}
.login-card{width:100%;max-width:368px;background:var(--surface);border:1px solid var(--line);
  border-radius:8px;box-shadow:var(--shadow);padding:30px;
  animation:rise 260ms cubic-bezier(.2,0,.2,1)}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

@media (max-width:820px){
  .shell{grid-template-columns:1fr}
  .side{flex-direction:row;align-items:center;gap:16px;padding:12px 16px;overflow-x:auto}
  .side-foot,.brand-sub{display:none}
  .nav{flex-direction:row;gap:4px}
  .content,.top{padding-left:16px;padding-right:16px}
  .grid2{grid-template-columns:1fr}
}
`;

/** Stroked, 1.5px, 16px. One visual weight across the whole dashboard. */
export const Icon: FC<{ name: keyof typeof PATHS; size?: number }> = ({ name, size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    style="flex:none"
  >
    {raw(PATHS[name])}
  </svg>
);

const PATHS = {
  gauge: '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="m13.4 10.6 4.1-4.1"/><path d="M3 12a9 9 0 0 1 18 0"/><path d="M3 12h2m14 0h2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  building: '<path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M9 7h2m-2 4h2m-2 4h2m5-6h2a2 2 0 0 1 2 2v8"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  message: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.5 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z"/>',
  exit: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  back: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
} as const;

type Nav = { href: string; label: string; icon: keyof typeof PATHS };

const NAV: Nav[] = [
  { href: '/admin', label: 'Overview', icon: 'gauge' },
  { href: '/admin/services', label: 'Services', icon: 'list' },
  { href: '/admin/facilities', label: 'Facilities', icon: 'building' },
  { href: '/admin/facts', label: 'State facts', icon: 'book' },
  { href: '/admin/queries', label: 'Questions', icon: 'message' },
  { href: '/admin/audit', label: 'Audit log', icon: 'shield' },
];

export const Shell: FC<PropsWithChildren<{ title: string; path: string; email: string }>> = ({
  title,
  path,
  email,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <title>{title} · MyImoGuide</title>
      <style>{raw(CSS)}</style>
    </head>
    <body>
      <div class="shell">
        <aside class="side">
          <div class="brand">
            <div class="brand-mark">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                {raw(PATHS.message)}
              </svg>
            </div>
            <div>
              <div class="brand-name">MyImoGuide</div>
              <div class="brand-sub">Administration</div>
            </div>
          </div>
          <nav class="nav">
            {NAV.map((item) => (
              <a href={item.href} aria-current={path === item.href ? 'page' : undefined}>
                <Icon name={item.icon} />
                {item.label}
              </a>
            ))}
          </nav>
          <div class="side-foot">
            Every change is recorded in the audit log with the account that made it.
          </div>
        </aside>

        <div class="main">
          <header class="top">
            <h1>{title}</h1>
            <div style="display:flex;align-items:center;gap:14px">
              <span class="top-meta">{email}</span>
              <form method="post" action="/admin/logout" style="margin:0">
                <button class="btn" type="submit">
                  <Icon name="exit" />
                  Sign out
                </button>
              </form>
            </div>
          </header>
          <main class="content">{children}</main>
        </div>
      </div>
    </body>
  </html>
);

export const LoginPage: FC<{ error?: string }> = ({ error }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <title>Sign in · MyImoGuide</title>
      <style>{raw(CSS)}</style>
    </head>
    <body>
      <div class="login">
        <div class="login-card">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:22px">
            <div class="brand-mark">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                {raw(PATHS.message)}
              </svg>
            </div>
            <div>
              <div style="font-weight:600;font-size:15px;letter-spacing:-.01em">MyImoGuide</div>
              <div style="font-size:12px;color:var(--ink-500)">Administration</div>
            </div>
          </div>

          {error ? (
            <div class="flash bad">
              <Icon name="alert" /> {error}
            </div>
          ) : null}

          <form method="post" action="/admin/login">
            <div class="field">
              <label for="email">Email</label>
              <input id="email" name="email" type="email" required autocomplete="username" autofocus />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" required autocomplete="current-password" />
            </div>
            <button class="btn primary" type="submit" style="width:100%;justify-content:center">
              <Icon name="lock" />
              Sign in
            </button>
          </form>

          <p style="font-size:12px;color:var(--ink-500);margin:18px 0 0;line-height:1.5">
            Authorised personnel only. Sign-in attempts are logged.
          </p>
        </div>
      </div>
    </body>
  </html>
);

/** Confidence rendered consistently everywhere it appears. */
export const ConfidenceBadge: FC<{ value: string | null }> = ({ value }) => {
  const map: Record<string, { cls: string; label: string }> = {
    confirmed: { cls: 'ok', label: 'Confirmed' },
    published: { cls: 'warn', label: 'Published' },
    unverified: { cls: 'muted', label: 'Unverified' },
  };
  const v = map[value ?? 'unverified'] ?? map.unverified!;
  return (
    <span class={`badge ${v.cls}`}>
      <span class="dot" />
      {v.label}
    </span>
  );
};

export function formatDate(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
