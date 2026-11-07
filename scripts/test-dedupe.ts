/**
 * Proves the silent-reply bug and its fix.
 *
 * Simulates the consumer's claim → work → retry sequence against an
 * in-memory store, for both the old single-state logic and the new
 * two-state logic, and asserts what the user receives.
 *
 *   npm run test:dedupe
 */
import assert from 'node:assert/strict';
import { type ClaimState, decideClaim } from '../src/dedupe';

/** The original logic: seen-before-work. Kept here only to prove it fails. */
function oldClaim(seen: Set<string>, id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
}

/**
 * Runs one queue message through up to 3 attempts. `failFirst` makes the
 * answer path throw on attempt 1, as an API error or timeout would.
 * Returns what the user received.
 */
function simulate(logic: 'old' | 'new', failFirst: boolean): string[] {
  const received: string[] = [];
  const seen = new Set<string>();
  const state = new Map<string, ClaimState>();
  const id = 'wamid.TEST';
  const MAX = 3;

  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      // --- claim ---
      if (logic === 'old') {
        if (!oldClaim(seen, id)) return received; // returns early, gets acked
      } else {
        if (decideClaim(state.get(id), attempt) === 'skip') return received;
        state.set(id, 'processing');
      }

      // --- work ---
      if (failFirst && attempt === 1) throw new Error('provider timeout');
      received.push('ANSWER');

      if (logic === 'new') state.set(id, 'done');
      return received; // acked
    } catch {
      if (attempt >= MAX) {
        received.push('APOLOGY');
        return received;
      }
      // retry
    }
  }
  return received;
}

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  pass  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}

console.log('\nThe bug, reproduced:');
check('old logic + first attempt fails -> user receives NOTHING', () => {
  assert.deepEqual(simulate('old', true), []);
});

console.log('\nThe fix:');
check('new logic + first attempt fails -> retry delivers the answer', () => {
  assert.deepEqual(simulate('new', true), ['ANSWER']);
});
check('new logic + no failure -> exactly one answer', () => {
  assert.deepEqual(simulate('new', false), ['ANSWER']);
});

console.log('\nDuplicate suppression still holds:');
check('Meta duplicate of a finished message is skipped', () => {
  assert.equal(decideClaim('done', 1), 'skip');
});
check('Meta duplicate of an in-flight message is skipped', () => {
  assert.equal(decideClaim('processing', 1), 'skip');
});
check('our own retry of an in-flight message proceeds', () => {
  assert.equal(decideClaim('processing', 2), 'proceed');
});
check('a finished message is never redone, even on retry', () => {
  assert.equal(decideClaim('done', 3), 'skip');
});
check('a new message proceeds', () => {
  assert.equal(decideClaim(undefined, 1), 'proceed');
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
