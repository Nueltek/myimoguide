import { Hono } from 'hono';
import { CONFIRM_WINDOW_MINUTES, safeNext } from './access';
import { markConfirmed } from './auth';
import type { Ctx } from './context';
import { AuthCard, Icon } from './layout';
import { checkSecondFactor, codeError, failed } from './twofactor';

/**
 * Re-entering a code before a sensitive action.
 *
 * Signing in proves the second factor once, for up to eight hours.
 * Managing accounts asks for it again if it was not given in the last
 * few minutes, so a laptop left signed in at a desk cannot be used to
 * invite someone or remove a colleague's access. Wrong codes here count
 * towards the same limit as at sign-in, and the fifth signs the person
 * out.
 */
export const confirm = new Hono<Ctx>();

confirm.get('/', (c) =>
  c.html(<ConfirmPage next={safeNext(c.req.query('next'))} repeat={c.req.query('repeat') === '1'} />),
);

confirm.post('/', async (c) => {
  const form = await c.req.formData();
  const next = safeNext(String(form.get('next') ?? ''));
  const result = await checkSecondFactor(c, String(form.get('code') ?? ''));
  if (result instanceof Response) return result;
  if (!result.ok) {
    return failed(c, (remaining) => <ConfirmPage next={next} error={codeError(result.reason, remaining)} />);
  }
  await markConfirmed(c.get('db'), c.get('session').sessionId);
  return c.redirect(next);
});

const ConfirmPage = ({ next, error, repeat }: { next: string; error?: string; repeat?: boolean }) => (
  <AuthCard title="Confirm it is you">
    <h1 class="auth-title">Confirm it is you</h1>
    <p class="auth-lede">
      Managing accounts and recovery codes needs a fresh code from your authenticator app. You will not be asked again
      for {CONFIRM_WINDOW_MINUTES} minutes.
    </p>
    {repeat && !error ? (
      <div class="flash warn" role="status">
        <Icon name="alert" /> Your last confirmation had expired, so that action was not carried out. Confirm, then do
        it again.
      </div>
    ) : null}
    {error ? (
      <div class="flash bad" role="alert">
        <Icon name="alert" /> {error}
      </div>
    ) : null}
    <form method="post" action="/admin/confirm">
      <input type="hidden" name="next" value={next} />
      <div class="field">
        <label for="code">Code</label>
        <input
          id="code"
          name="code"
          type="text"
          class="code-input"
          autocomplete="one-time-code"
          maxlength={20}
          required
          autofocus
          aria-describedby="code-hint"
        />
        <div class="hint" id="code-hint">
          The 6-digit code from your app, or one of your recovery codes.
        </div>
      </div>
      <button class="btn primary" type="submit" data-busy-label="Checking..." style="width:100%;justify-content:center">
        <Icon name="lock" /> Confirm
      </button>
    </form>
    <a class="btn ghost sm" href="/admin" style="margin-top:14px;padding-left:0">
      <Icon name="back" size={14} /> Cancel
    </a>
  </AuthCard>
);
