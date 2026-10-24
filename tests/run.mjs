/**
 * Zero-dependency test runner.
 *
 *   npm test                     all tests
 *   npm test -- --bank exbank    one bank's fixtures
 *   npm test -- --filter money   unit tests whose name matches
 *
 * Exits non-zero on any failure, so it works as a pre-commit or CI gate.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cases, state, test, assertSame, assertTrue, testParser } from './harness.mjs';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null; };
const bankFilter = opt('--bank');
const nameFilter = opt('--filter');


// --- fixtures ------------------------------------------------
const FIELD_MAP = { account: 'account_hint', payee: 'payee_raw', amount_paise: 'amount_paise',
                    direction: 'direction', channel: 'channel', vpa: 'vpa', ref: 'ref' };

function registerFixtures(bank) {
  for (const dir of readdirSync('tests/fixtures', { withFileTypes: true }).filter(d => d.isDirectory())) {
    if (bank && dir.name !== bank) continue;
    for (const file of readdirSync(`tests/fixtures/${dir.name}`).filter(f => f.endsWith('.json')).sort()) {
      const fx = JSON.parse(readFileSync(`tests/fixtures/${dir.name}/${file}`, 'utf8'));
      test(`fixture ${dir.name}/${fx.name ?? file}`, () => runFixture(fx));
    }
  }
}

async function runFixture(fx) {
  const expect = fx.expect ?? {};
  const receivedAt = fx.received_at ? Date.parse(fx.received_at) / 1000
                                    : Date.parse('2026-09-16 12:41:05 +05:30') / 1000;
  const r = await testParser().parse(fx.text ?? '', fx.sender ?? null, receivedAt);

  assertSame(expect.status ?? 'parsed', r.status, 'parse status');
  if (expect.ignore_reason !== undefined) assertSame(expect.ignore_reason, r.ignore_reason, 'ignore reason');
  if (expect.generic !== undefined) assertSame(expect.generic, r.generic, 'parsed by generic profile');
  if (expect.profile !== undefined) assertSame(expect.profile, r.profile, 'profile');
  if (expect.no_balance_in_text) {
    assertTrue(!/\b(avl|available)\.?\s*bal/i.test(r.text), `balance left in stored text: ${r.text}`);
  }
  if ((expect.status ?? 'parsed') !== 'parsed') return;

  assertTrue(r.tx !== null, 'expected a parsed transaction');
  // An expectation the runner does not understand asserted nothing at all, and
  // the fixture passed anyway. A profile written against `account_hint` rather
  // than `account` shipped twice before this guard existed.
  const KNOWN = new Set([...Object.keys(FIELD_MAP), 'status', 'ignore_reason',
                         'generic', 'profile', 'no_balance_in_text', 'occurred_at']);
  for (const k of Object.keys(expect)) {
    assertTrue(KNOWN.has(k), `fixture expects unknown field "${k}" — it would be ignored`);
  }
  for (const [fixtureKey, txKey] of Object.entries(FIELD_MAP)) {
    if (!(fixtureKey in expect)) continue;
    assertSame(expect[fixtureKey], r.tx[txKey] ?? null, `field ${fixtureKey}`);
  }
  if (expect.occurred_at !== undefined) {
    assertSame(Date.parse(expect.occurred_at) / 1000, r.tx.occurred_at, 'occurred_at');
  }
}

// --- load unit tests, then run ----------------------------------------------
// --bank narrows to one bank's fixtures, which is what you want while writing a
// profile. Without it, unit tests run too.
if (!bankFilter && existsSync('tests/unit')) {
  for (const f of readdirSync('tests/unit').filter(f => f.endsWith('.test.mjs')).sort()) {
    await import(pathToFileURL(`tests/unit/${f}`).href);
  }
}
registerFixtures(bankFilter);

if (cases.length === 0) { console.error('no tests matched'); process.exit(1); }

// Several tests deliberately exercise paths that log (a rejected body, a
// broken parser pattern). Capture that rather than letting it interleave with
// the progress output; it is replayed only for a failing test.
const logged = [];
const realError = console.error;
console.error = (...args) => logged.push(args.map(String).join(' '));

const start = Date.now();
let passed = 0; const failures = [];
for (const c of cases) {
  if (nameFilter && !c.name.toLowerCase().includes(nameFilter.toLowerCase())) continue;
  logged.length = 0;
  try { await c.fn(); passed++; process.stdout.write('.'); }
  catch (e) {
    const noise = logged.length ? `\n      logged: ${logged.join(' | ')}` : '';
    failures.push(`${c.name}\n      ${e.message}${noise}`);
    process.stdout.write('F');
  }
}
console.error = realError;
console.log('\n');
failures.forEach((f, i) => console.log(`FAIL ${i + 1}) ${f}\n`));
console.log(`${passed} passed, ${failures.length} failed, ${state.assertions} assertions in ${((Date.now() - start) / 1000).toFixed(2)}s`);
process.exit(failures.length ? 1 : 0);
