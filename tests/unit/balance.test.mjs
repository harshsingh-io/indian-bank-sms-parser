import { test, assertSame, assertTrue, assertNull, testParser } from '../harness.mjs';
import { readBalance, reconcile } from '../../src/balance.ts';

/** Reading a balance out of a bank SMS, and reconciling two of them. */

test('balance: the phrasings the banks actually use', () => {
  const cases = [
    ['Your A/c XX1001 Avl Bal Rs.12,345.67', 1234567, '1001'],
    ['Available Balance is Rs. 500.00 in A/c no XXXX2002', 50000, '2002'],
    ['Your A/c X4338-Rs.1,234.50 as on 13Oct26', 123450, '4338'],
    ['Balance: Rs 9,99,999.99', 99999999, null],
    ['Avl Limit on Card XX6009 is Rs.1,50,000', 15000000, '6009'],
  ];
  for (const [text, paise, acct] of cases) {
    const r = readBalance(text, false);
    assertTrue(r !== null, `no reading from: ${text}`);
    assertSame(paise, r.balance_paise, text);
    assertSame(acct, r.account_hint, `account in: ${text}`);
  }
});

test('balance: money is integer paise, never a float', () => {
  // 0.1 + 0.2 is the reason. A balance ending .70 must not drift.
  assertSame(1234570, readBalance('Avl Bal Rs.12,345.70', false).balance_paise);
  assertSame(100, readBalance('Avl Bal Rs.1.00', false).balance_paise);
  assertSame(10, readBalance('Avl Bal Rs.0.1', false).balance_paise, '0.1 is ten paise');
});

test('balance: a message describing money moving is NOT a balance reading', () => {
  // A debit alert quoting the resulting balance is one event. Recording its
  // balance separately would count the same moment twice.
  assertNull(readBalance('Rs.500 debited from A/c XX1001. Avl Bal Rs.12,345.67', true));
});

test('balance: nonsense is refused rather than guessed at', () => {
  assertNull(readBalance('', false));
  assertNull(readBalance('Your OTP is 123456', false));
  assertNull(readBalance('Avl Bal Rs.', false), 'no figure');
  assertNull(readBalance('Dear customer, thank you for banking with us', false));
});

test('balance: the parser reads it before stripping the text', async () => {
  // Balances are scrubbed out of stored text. The number still has to survive,
  // in its own column, or the completeness check is impossible.
  const r = await testParser().parse(
    'Your A/c XX1001 Avl Bal Rs.12,345.67 as on 13Oct26', 'HDFCBK-S',
    Math.floor(Date.parse('2026-10-13T10:00:00+05:30') / 1000));
  assertSame('ignored', r.status, 'still not a transaction');
  assertSame('not_transaction', r.ignore_reason);
  assertTrue(r.balance !== null, 'but the figure is captured');
  assertSame(1234567, r.balance.balance_paise);
  assertTrue(!/12,345/.test(r.text), `the figure must be gone from stored text: ${r.text}`);
});

// --- reconciliation ---------------------------------------------------------

const at = (iso) => Math.floor(Date.parse(iso) / 1000);
const open = { observed_at: at('2026-10-01T09:00:00+05:30'), balance_paise: 1000000 };
const close = { observed_at: at('2026-10-08T09:00:00+05:30'), balance_paise: 900000 };

test('balance: two readings that agree with the ledger show no gap', () => {
  const r = reconcile(open, close, [
    { occurred_at: at('2026-10-03T12:00:00+05:30'), amount_paise: 150000, direction: 'debit' },
    { occurred_at: at('2026-10-05T12:00:00+05:30'), amount_paise: 50000, direction: 'credit' },
  ]);
  assertSame(-100000, r.recorded_paise, '1,500 out and 500 in');
  assertSame(-100000, r.observed_paise);
  assertSame(0, r.gap_paise, 'the bank and the ledger agree');
  assertSame(2, r.movements);
});

test('balance: a missed payment shows up as a gap', () => {
  // This is the whole point: for an account that sends SMS for a fraction of
  // its activity, the bank's own arithmetic is the only cheap proof.
  const r = reconcile(open, close, [
    { occurred_at: at('2026-10-03T12:00:00+05:30'), amount_paise: 40000, direction: 'debit' },
  ]);
  assertSame(-40000, r.recorded_paise);
  assertSame(-100000, r.observed_paise);
  assertSame(-60000, r.gap_paise, 'Rs.600 left the account unrecorded');
});

test('balance: only movements between the two readings count', () => {
  const r = reconcile(open, close, [
    { occurred_at: at('2026-09-20T12:00:00+05:30'), amount_paise: 999999, direction: 'debit' },
    { occurred_at: at('2026-10-20T12:00:00+05:30'), amount_paise: 999999, direction: 'debit' },
    { occurred_at: at('2026-10-03T12:00:00+05:30'), amount_paise: 100000, direction: 'debit' },
  ]);
  assertSame(1, r.movements, 'the ones outside the window are irrelevant');
  assertSame(0, r.gap_paise);
});

