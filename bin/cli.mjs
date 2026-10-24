#!/usr/bin/env node
/**
 * Paste a bank SMS, find out whether it parses.
 *
 *   npx indian-bank-sms-parser "Sent Rs.1,250.50 From HDFC Bank A/C *1001 ..."
 *   pbpaste | npx indian-bank-sms-parser --sender VM-HDFCBK
 *
 * If it parses you get the transaction. If it does not, you get the message
 * back with every identifying value replaced, plus a fixture ready to drop
 * into tests/ -- so "my bank is not supported" turns into a contribution
 * without anybody having to read the parser first.
 *
 * NOTHING LEAVES YOUR MACHINE. This makes no network calls of any kind; the
 * masked text is printed for you to check and paste somewhere yourself.
 */
import { readFileSync } from 'node:fs';
import { createParser, BANK_PROFILES } from '../src/index.ts';
import { mask } from '../src/mask.ts';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);

if (has('--help') || has('-h')) {
  console.log(`
  indian-bank-sms-parser — check whether an SMS parses

    npx indian-bank-sms-parser "<sms text>"
    pbpaste | npx indian-bank-sms-parser --sender VM-HDFCBK

  Options
    --sender <id>   the SMS sender, e.g. VM-HDFCBK. Without it, detection
                    falls back to the message body (the iOS case).
    --raw           print the unmasked parse too. Off by default so a
                    screenshot of this output is safe to share.
    --json          machine-readable output.

  Nothing is uploaded. Masking happens locally, for you to paste yourself.
`);
  process.exit(0);
}

const positional = argv.filter((a, i) =>
  !a.startsWith('--') && argv[i - 1] !== '--sender');
const text = positional.join(' ').trim() || readFileSync(0, 'utf8').trim();
if (!text) {
  console.error('nothing to parse. Pass the SMS as an argument or on stdin.');
  process.exit(1);
}
const sender = flag('--sender');

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

const parser = createParser({ requireKnownSender: Boolean(sender) });
const r = await parser.parse(text, sender, Math.floor(Date.now() / 1000));
const { text: masked, leftover } = mask(text);

if (has('--json')) {
  console.log(JSON.stringify({ status: r.status, ignore_reason: r.ignore_reason,
    profile: r.profile, tx: r.tx, masked }, null, 2));
  process.exit(r.status === 'parsed' ? 0 : 1);
}

const rupees = (p) => `${Math.floor(p / 100).toLocaleString('en-IN')}.${String(p % 100).padStart(2, '0')}`;

if (r.status === 'parsed') {
  console.log(`\n  PARSED by ${r.profile}${r.generic ? '  (generic fallback — a real profile would do better)' : ''}\n`);
  const t = r.tx;
  const row = (k, v) => v !== null && v !== undefined && console.log(`    ${k.padEnd(10)} ${v}`);
  row('amount', `Rs.${rupees(t.amount_paise)}   (${t.amount_paise} paise)`);
  row('direction', t.direction);
  row('channel', t.channel);
  row('account', t.account_hint);
  row('payee', t.payee_raw);
  row('vpa', t.vpa);
  row('ref', t.ref);
  row('when', new Date(t.occurred_at * 1000).toISOString());
  if (has('--raw')) console.log(`\n    stored text: ${r.text}`);
  // A generic match is a result, not a success. It found an amount and a
  // direction by brute force and will get the payee wrong more often than
  // not, so offer the contribution path here too -- this is precisely the
  // message a real profile would improve.
  if (r.generic) offerFixture('The generic fallback matched, but a profile for this bank would read it properly.');
  console.log('');
  process.exit(0);
}

if (r.status === 'ignored') {
  const why = {
    otp: 'it is a one-time password, which is never parsed or stored',
    not_transaction: 'no money moved — a balance reply, a mandate notice or a failed payment',
    sender_not_allowed: `no profile claims the sender "${sender}". Drop --sender to detect from the text instead`,
  }[r.ignore_reason] ?? r.ignore_reason;
  console.log(`\n  IGNORED — ${why}\n`);
  process.exit(0);
}

// Unparsed: hand back everything needed to make it parse.
offerFixture(`NOT PARSED. None of the ${BANK_PROFILES.length} bundled profiles matched.`);
process.exit(1);

function offerFixture(headline) {
  console.log(`
  ${headline}

  Below is your message with every identifying value replaced. Check it,
  then open an issue with it — that is all a new bank needs to get started.
  Nothing has been uploaded; this was printed locally.

  ---- masked message ----
${masked.split('\n').map((l) => `  ${l}`).join('\n')}
  ------------------------
${leftover.length ? `
  CHECK THESE before you post. They are capitalised words this did not
  recognise, and one of them may be a name:

    ${leftover.join('  ')}
` : ''}
  As a fixture, save to tests/fixtures/<bank>/01-whatever.json:

${JSON.stringify({
    name: 'describe the message',
    sender: sender ?? 'VM-YOURBANK',
    received_at: new Date().toISOString().slice(0, 19).replace('T', ' ') + ' +05:30',
    text: masked,
    expect: { status: 'parsed', direction: 'debit', channel: 'upi', amount_paise: 0 },
  }, null, 2).split('\n').map((l) => `  ${l}`).join('\n')}

  Fill in the expected values, then: npm test -- --bank <bank>
  See CONTRIBUTING.md for the profile that makes it pass.
`);
}
