/**
 * Create or reset a dashboard account.
 *
 *   $env:DATABASE_URL='postgresql://...'
 *   npx tsx scripts/create-admin.ts you@example.com 'a long passphrase'
 *
 * Pass the password as an argument only on your own machine — it lands in
 * shell history. Omit it and one is generated and printed once.
 */
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { adminUsers } from '../src/db/schema';
import { hashPassword } from '../src/admin/auth';

const MIN_LENGTH = 14;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new Error('Usage: tsx scripts/create-admin.ts <email> [password]');
  }

  // Generated passwords are long because the KDF runs at a reduced
  // iteration count to fit the Workers CPU budget — length is what
  // compensates. See the note at the top of src/admin/auth.ts.
  const supplied = process.argv[3];
  const password = supplied ?? generate();

  if (password.length < MIN_LENGTH) {
    throw new Error(`Password must be at least ${MIN_LENGTH} characters.`);
  }

  const db = drizzle(neon(url), { casing: 'snake_case' });
  const passwordHash = await hashPassword(password);

  const existing = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);

  if (existing[0]) {
    await db
      .update(adminUsers)
      .set({ passwordHash, isActive: true })
      .where(eq(adminUsers.id, existing[0].id));
    console.log(`Password reset for ${email}`);
  } else {
    await db.insert(adminUsers).values({ email, passwordHash, role: 'admin' });
    console.log(`Created ${email}`);
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
