#!/usr/bin/env node
/**
 * Gate the Worker bundle against the Cloudflare free-plan ceiling.
 *
 * The free plan allows 3 MB gzipped. This is the constraint that ruled out
 * LangChain and Mastra, so it is enforced in CI rather than remembered —
 * a dependency added six weeks from now must not quietly break the deploy.
 *
 * Fails the build above WARN_KIB so there is room to react before the real
 * ceiling, and above MAX_KIB unconditionally.
 */
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_KIB = 3 * 1024; // hard free-plan ceiling
const WARN_KIB = 2 * 1024; // react before it bites

const OUT = '.dist';

execFileSync('npx', ['wrangler', 'deploy', '--dry-run', `--outdir=${OUT}`], {
  stdio: 'inherit',
});

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * Count only what Cloudflare counts.
 *
 * `.dist` also holds `index.js.map`, which is several times larger than the
 * script itself. Sourcemaps upload separately and do not count toward the
 * Worker size limit, so including them would fail the gate on a bundle that
 * deploys fine. README.md is wrangler's own scaffolding note.
 */
const COUNTED = /\.(js|mjs|cjs|wasm)$/;

let totalGzip = 0;
const counted = [];
for (const file of walk(OUT)) {
  if (!COUNTED.test(file) || file.endsWith('.map')) continue;
  const bytes = gzipSync(readFileSync(file)).length;
  counted.push(`  ${file}: ${(bytes / 1024).toFixed(1)} KiB`);
  totalGzip += bytes;
}

if (counted.length === 0) {
  console.error(`FAIL: no deployable files found in ${OUT}/ — did the build run?`);
  process.exit(1);
}
console.log(`\nCounted (gzipped):\n${counted.join('\n')}`);

const kib = totalGzip / 1024;
const pct = ((kib / MAX_KIB) * 100).toFixed(1);

console.log(`\nBundle: ${kib.toFixed(1)} KiB gzipped (${pct}% of the ${MAX_KIB} KiB free-plan ceiling)`);

if (kib > MAX_KIB) {
  console.error(`\nFAIL: over the ${MAX_KIB} KiB free-plan ceiling. The Worker will not deploy.`);
  process.exit(1);
}
if (kib > WARN_KIB) {
  console.error(`\nFAIL: over the ${WARN_KIB} KiB warning line. Trim a dependency before it reaches the real ceiling.`);
  process.exit(1);
}

console.log('PASS\n');
