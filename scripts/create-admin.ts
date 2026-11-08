/**
 * Create or reset a dashboard account.
 *
 *   $env:DATABASE_URL='postgresql://...'
 *   npx tsx scripts/create-admin.ts you@example.com 'a long passphrase'
 *   npx tsx scripts/create-admin.ts you@example.com --reset-2fa
 *   npx tsx scripts/create-admin.ts official@imostate.gov.ng --name "Ada Okafor" --role administrator
 *
 * This script is for the first administrators at handover, and for break-
 * glass recovery if every administrator is locked out. Day to day, people
 * are invited from the dashboard's Users page instead — that way each new
 * account is created by a named administrator, on the record, and chooses
 * its own password.
 *
 * New accounts default to administrator. --role sets editor or viewer;
 * on an existing account it changes the role.
 *
 * Pass the password as an argument only on your own machine — it lands in
 * shell history. Omit it and one is generated and printed once.
 *
 * --reset-2fa is for an official who has lost both their phone and their
 * recovery codes. It removes their authenticator, so the next sign-in
 * goes through setup again, and signs them out everywhere. Confirm who is
 * asking before running it: it is the one way around the second factor.
 */
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { adminSessions, adminUsers, auditLog } from '../src/db/schema';
import { hashPassword, passwordProblem } from '../src/admin/auth';
import { ROLES, asRole } from '../src/admin/access';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const args = process.argv.slice(2);
  const reset2fa = args.includes('--reset-2fa');
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const roleArg = flag('--role');
  const nameArg = flag('--name')?.trim();
  if (roleArg !== undefined && !asRole(roleArg)) throw new Error(`--role must be one of: ${ROLES.join(', ')}`);
  const role = asRole(roleArg);
  // Everything that is not a flag or a flag's value.
  const positional = args.filter((a: string, i: number) => !a.startsWith('--') && !['--role', '--name'].includes(args[i - 1] ?? ''));

  const email = positional[0]?.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new Error('Usage: tsx scripts/create-admin.ts <email> [password] [--role administrator|editor|viewer] [--name "Full Name"] | <email> --reset-2fa');
  }

  const db = drizzle(neon(url), { casing: 'snake_case' });
  const [existing] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);

  if (reset2fa) {
    if (!existing) throw new Error(`No account for ${email}`);
    await db
      .update(adminUsers)
      .set({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodeHashes: [] })
      .where(eq(adminUsers.id, existing.id));
    await db.delete(adminSessions).where(eq(adminSessions.userId, existing.id));
    await db.insert(auditLog).values({
      actorId: null,
      actorEmail: '(command line)',
      action: 'twofa_reset',
      tableName: 'admin_users',
      rowId: existing.id,
      before: null,
      after: { email },
    });
    console.log(`Two-step sign-in removed for ${email}, and all their sessions ended.`);
    console.log('They will be asked to set up an authenticator app at their next sign-in.');
    return;
  }

  // Generated passwords are long because the KDF runs at a reduced
  // iteration count to fit the Workers CPU budget — length is what
  // compensates. See the note at the top of src/admin/auth.ts.
  const supplied = positional[1];
  const password = supplied ?? generate();

  const problem = passwordProblem(password, email);
  if (problem) throw new Error(problem);

  const passwordHash = await hashPassword(password);

  if (existing) {
    await db
      .update(adminUsers)
      .set({ passwordHash, isActive: true, deactivatedAt: null, ...(role ? { role } : {}), ...(nameArg ? { fullName: nameArg } : {}) })
      .where(eq(adminUsers.id, existing.id));
    // A password reset ends every session: if the reset is because the
    // old one leaked, a session opened with it must not survive.
    await db.delete(adminSessions).where(eq(adminSessions.userId, existing.id));
    console.log(`Password reset for ${email}${role ? `, role set to ${role}` : ''}. All their sessions have been ended.`);
  } else {
    await db.insert(adminUsers).values({ email, passwordHash, role: role ?? 'administrator', fullName: nameArg ?? null });
    console.log(`Created ${email} as ${role ?? 'administrator'}. They will set up two-step sign-in at first sign-in.`);
  }

  if (!supplied) {
    console.log(`\nPassword (shown once — save it now):\n\n  ${password}\n`);
  }
}

function generate(): string {
  const words = 'anchor,basalt,cobalt,dunlin,ember,fathom,granite,harbour,indigo,juniper,kestrel,lantern,marble,nimbus,orchid,pewter,quarry,rampart,sable,thistle,umber,verdant,willow,zenith'.split(',');
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0]! % words.length]!;
  const digits = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 10000).padStart(4, '0');
  return `${pick()}-${pick()}-${pick()}-${digits}`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
