import { test, assertSame, assertTrue } from '../harness.mjs';
import { mask } from '../../src/mask.ts';

/**
 * Masking an SMS for sharing.
 *
 * Two things can go wrong and only one of them is recoverable. Leaving an
 * account number in costs somebody their privacy in a public repository.
 * Masking too much costs a fixture that no longer looks like a bank message,
 * which is merely useless. The tests below pin both ends.
 */

const m = (s) => mask(s).text;

test('mask: the things that identify a person are gone', () => {
  const out = m('Rs.4,827.50 debited from A/c XX7742 towards '
    + 'UPI/DR/529183047261/RAJESH KUMAR SHARMA/KKBK. SMS to 9876543210.');
  assertTrue(!out.includes('RAJESH'), 'the payee name survived');
  assertTrue(!out.includes('7742'), 'the account digits survived');
  assertTrue(!out.includes('529183047261'), 'the reference survived');
  assertTrue(!out.includes('9876543210'), 'the phone number survived');
  assertTrue(!out.includes('4,827.50'), 'the amount survived');
});

test('mask: the shape of the message is preserved', () => {
  // An over-eager matcher turned this into "PAYEE 4, ... PAYEE 5/c ... on
  // 23-PAYEE 6-26", which is unrecognisable as anything a bank sends and so
  // worthless as a fixture.
  const out = m('Dear Customer, Rs.4,827.50 has been debited from your '
    + 'Kotak Bank A/c XX7742 on 23-Oct-26 towards UPI/DR/529183047261/A NAME/KKBK.');
  assertTrue(out.startsWith('Dear Customer,'), out);
  assertTrue(out.includes('Kotak Bank A/c XX'), 'the bank and account marker must survive');
  assertTrue(out.includes('on 23-Oct-26'), 'the date must survive');
  assertTrue(out.includes('UPI/DR/'), 'the rail must survive: a profile matches on it');
});

test('mask: a replacement is never masked a second time', () => {
  // The phone rule wrote 7308080808, then the reference rule saw ten digits
  // and renumbered it. Each match is held as a placeholder for that reason.
  const out = m('Call 18001234567 or SMS BLOCK to 9876543210');
  assertTrue(out.includes('7308080808'), `phone placeholder was clobbered: ${out}`);
  assertTrue(out.includes('18001234567'), 'a published helpline is not a personal number');
});

test('mask: one payee stays one payee', () => {
  const out = m('to RAJESH KUMAR paid 100 and to RAJESH KUMAR paid 200 and to MEENA RAO paid 50');
  assertSame(2, (out.match(/A PAYEE/g) ?? []).length, 'the same name must map to the same alias');
  assertTrue(out.includes('PAYEE 2'), 'a different name must get a different alias');
});

test('mask: amounts keep their grouping, so the pattern is still exercised', () => {
  const out = m('Rs.1,23,456.78 debited');
  assertTrue(out.includes('1,11,111.11'), `Indian digit grouping lost: ${out}`);
  assertTrue(!out.includes('123456'), 'the real amount survived');
});

test('mask: a rail is not a person', () => {
  // "towards UPI/DR/..." introduces a payment rail. Masking the word UPI
  // removes the one token a profile matches on.
  for (const rail of ['UPI', 'IMPS', 'NEFT', 'RTGS']) {
    const out = m(`Rs.100 sent to ${rail}/DR/100000000001/SOMEONE/BANK`);
    assertTrue(out.includes(rail), `${rail} was masked as a name: ${out}`);
  }
});

test('mask: a VPA is replaced but still looks like a VPA', () => {
  const out = m('paid to realperson.name@okaxis for lunch');
  assertTrue(!out.includes('realperson'), 'the handle survived');
  assertTrue(/payee\d+@\w+/.test(out), `the result no longer looks like a VPA: ${out}`);
});

test('mask: what it could not classify is reported, not silently kept', () => {
  // The honest half: anything capitalised and unrecognised is handed back for
  // a human to look at, rather than assumed safe.
  const { leftover } = mask('Rs.100 paid at ZORBA WELLNESS CENTRE on 01-Jan-26');
  assertTrue(leftover.some((w) => /ZORBA|WELLNESS|CENTRE/i.test(w)),
    `an unrecognised name was not flagged: ${JSON.stringify(leftover)}`);
  // ...while the ordinary furniture of a bank SMS is not flagged as a worry.
  const { leftover: quiet } = mask('Rs.100 debited from A/c XX1234 on 01-Jan-26. Avl Bal Rs.50');
  assertSame(0, quiet.length, `false alarms: ${JSON.stringify(quiet)}`);
});
