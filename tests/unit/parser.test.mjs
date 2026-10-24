import { test, assertSame, assertNull, assertTrue, testParser } from '../harness.mjs';
import { Parser } from '../../src/parser.ts';

/** Parser behaviour that fixtures cannot express. */

test('parser: normalize unifies currency markers', () => {
  for (const v of ['Rs 180', 'Rs.180', 'INR 180', '₹180', '₹ 180', 'Rs180', 'INR180']) {
    assertSame('Rs.180', Parser.normalize(v), `variant: ${v}`);
  }
  // Regression: a marker glued to its digits. "\bRs\b" never matched these,
  // because there is no word boundary between "s" and "2", so the amount was
  // unreadable to every profile.
  assertSame('Rs.274.0', Parser.normalize('Rs274.0'));
  assertSame('Rs.10000 frm u', Parser.normalize('Rs10000 frm u'));
});

test('parser: normalize leaves a bare marker with no amount alone', () => {
  assertSame('Rs and INR are both rupees', Parser.normalize('Rs and INR are both rupees'));
});

test('parser: normalize collapses spaces but keeps newlines', () => {
  // Field patterns anchor to line starts, so a newline is structure.
  assertSame('Sent Rs.180.00\nTo AAHARA CAFE', Parser.normalize('Sent   Rs.180.00  \r\n  To   AAHARA CAFE  '));
  assertSame('a\nb', Parser.normalize('a\n\n\n b'));
});

test('parser: hash is stable across whitespace and sender case', async () => {
  const a = Parser.normalize('Sent Rs.180.00\nTo AAHARA CAFE');
  const b = Parser.normalize('Sent   Rs.180.00\r\nTo AAHARA CAFE ');
  assertSame(await Parser.hash(a, 'AX-EXBANK-S'), await Parser.hash(b, 'ax-exbank-s'));
});

test('parser: hash differs by sender and by text', async () => {
  const t = Parser.normalize('Sent Rs.180.00');
  assertTrue(await Parser.hash(t, 'AX-EXBANK-S') !== await Parser.hash(t, 'AX-OTHER-S'));
  assertTrue(await Parser.hash(t, 'AX-EXBANK-S') !== await Parser.hash(Parser.normalize('Sent Rs.181.00'), 'AX-EXBANK-S'));
});

test('parser: otp detection covers the shapes banks actually send', () => {
  for (const t of ['123456 is your OTP for Example Bank', 'Your one-time password is 9821',
                   'Verification code: 4432', 'Use access code 1122 to log in']) {
    assertTrue(Parser.isOtp(t), `should be OTP: ${t}`);
  }
  assertSame(false, Parser.isOtp('Sent Rs.180.00\nTo AAHARA CAFE'));
});

test('parser: strip balance removes the fragment and leaves the rest', () => {
  const stripped = Parser.stripBalance(Parser.normalize('Sent Rs.180.00\nTo AAHARA CAFE\nAvl Bal Rs.45,231.80'));
  assertTrue(!/45,231/.test(stripped), 'balance digits must be gone');
  assertTrue(stripped.includes('Rs.180.00'), 'the amount must survive');
  assertTrue(stripped.includes('AAHARA CAFE'), 'the payee must survive');
});

test('parser: store_balance keeps the balance when asked', async () => {
  const r = await testParser({ storeBalance: true }).parse(
    'Sent Rs.180.00\nFrom HDFC Bank A/C *1001\nTo AAHARA CAFE\nOn 16/09/26\nRef 100000000001\nAvl Bal Rs.45,231.80',
    'HDFCBK-S(smsft)', Date.parse('2026-09-16 12:41:05 +05:30') / 1000);
  assertTrue(r.text.includes('45,231.80'), 'balance should be kept');
});

test('parser: an unrecognisable message is unparsed, not ignored', async () => {
  const r = await testParser().parse('Your statement is ready to view.', 'HDFCBK-S(smsft)', Date.now() / 1000);
  assertSame('unparsed', r.status);
  assertNull(r.tx);
});

test('parser: a malformed pattern does not take the request down', async () => {
  const broken = new Parser([{ id: 'broken', senders: ['BROKEN'], templates: [
    { id: 'b1', detect: '(?i)^Sent\\s+Rs\\.', direction: 'debit', fields: { amount: '(?<amount>[unclosed' } },
  ] }], null, { requireKnownSender: false });
  assertSame('unparsed', (await broken.parse('Sent Rs.180.00', 'AX-BROKEN-S', Date.now() / 1000)).status);
});

test('parser: a balance alert is only ruled out after every template declines', async () => {
  // Regression. This check used to run before template matching and asked "is
  // there a movement word?" of a fixed list. A real SBI reversal says "has
  // credit for ..." -- the noun, not "credited" -- so it was discarded as noise
  // before any template saw it.
  const p = testParser();
  const r = await p.parse(
    'Your A/C XXXXX100002 has credit for UPI/REVERSAL/100000000005/0112 of Rs 2.00 on 03/12/25. Avl Bal Rs 20,407.29.-SBI',
    'SBIUPI-S(smsft)', Date.parse('2025-12-03 11:30:00 +05:30') / 1000);
  assertSame('parsed', r.status, 'a reversal is a transaction, not a balance alert');
  assertSame(200, r.tx.amount_paise);

  const alert = await p.parse('Your A/C XXXXX100002 has Avl Bal Rs 20,407.29 as on 03/12/25.-SBI',
    'SBIBNK-S(smsft)', Date.now() / 1000);
  assertSame('ignored', alert.status);
  assertSame('not_transaction', alert.ignore_reason);
});

test('parser: an amount with no currency marker is still read', async () => {
  // SBI writes "debited by 305.0" with no Rs anywhere.
  const r = await testParser().parse(
    'Dear UPI user A/C X1001 debited by 305.0 on date 08Oct25 trf to AAHARA CAFE Refno 100000000001-SBI',
    'SBIUPI-S(smsft)', Date.parse('2025-10-08 14:20:00 +05:30') / 1000);
  assertSame('parsed', r.status);
  assertSame(30500, r.tx.amount_paise, '305.0 is 305 rupees, 0 paise');
});

test('parser: a profile can refuse to let the generic profile guess', async () => {
  // A wallet sends mostly marketing. Without this, generic templates match ad
  // copy: "Personal loan upto Rs 4,00,000" becomes a 4 lakh income.
  const marketing = 'Service Update: you have a Personal loan upto Rs 4,00,000. We have received your interest.';
  const generic = { templates: [{ id: 'g', detect: '(?i)\\breceived\\b', direction: 'credit',
                                  fields: { amount: '(?i)Rs\\.(?<amount>[\\d,]+(?:\\.\\d{1,2})?)' } }] };

  const guessing = new Parser([{ id: 'loose', senders: ['LOOSE'], templates: [] }], generic, { requireKnownSender: true });
  const guessed = await guessing.parse(marketing, 'XX-LOOSE-S', Date.now() / 1000);
  assertSame('parsed', guessed.status, 'baseline: the fallback does fire');
  assertSame(40000000, guessed.tx.amount_paise, 'and invents 4 lakh');

  const strict = new Parser([{ id: 'strict', senders: ['STRICT'], generic_fallback: false, templates: [] }],
    generic, { requireKnownSender: true });
  const r = await strict.parse(marketing, 'XX-STRICT-S', Date.now() / 1000);
  assertSame('unparsed', r.status, 'opted out, so no transaction is invented');
  assertNull(r.tx);
});

test('parser: a collect request is never a transaction', async () => {
  const p = testParser({ requireKnownSender: false });
  for (const t of [
    'EXAMPLE LTD has requested money from you on CRED. On approving, Rs.49 will be debited',
    'PhonePe UPI Circle payment request: 1948 has requested a payment of Rs.263 to EXAMPLE',
    'EXAMPLE FD has requested Rs10000 frm u on a UPI app. Once approved, money will be debited',
    'EXAMPLE MEDIA has sent you an AutoPay request for up to Rs. 299. Click to approve',
  ]) {
    const r = await p.parse(t, null, Date.now() / 1000);
    assertSame('ignored', r.status, `should be ignored: ${t}`);
    assertSame('pre_debit_notice', r.ignore_reason);
  }
});

test('parser: sms date within two days keeps the phone receipt time', async () => {
  const receivedAt = Math.floor(Date.parse('2025-10-09 09:00:00 +05:30') / 1000);
  const r = await testParser().parse(
    'Sent Rs.99.00\nFrom HDFC Bank A/C *1001\nTo INDIGO SALON\nOn 08/10/25\nRef 100000000015',
    'HDFCBK-S(smsft)', receivedAt);
  assertSame('parsed', r.status);
  assertSame(receivedAt, r.tx.occurred_at, 'a near-same-day SMS keeps received_at');
});

test('parser: an sms dated in the future is not trusted', async () => {
  // Real HDFC messages carry the wrong year -- "On 28/12/26" arriving in
  // December 2025. The "prefer the SMS date" rule assumes a DELAYED message,
  // where the SMS date is earlier. Taking a future date at face value files a
  // year of ordinary spending where no statement can ever match it.
  const received = Math.floor(Date.parse('2025-12-28 00:23:00 +05:30') / 1000);
  const r = await testParser().parse(
    'Sent Rs.110.00\nFrom HDFC Bank A/C *1001\nTo AAHARA CAFE\nOn 28/12/26\nRef 100000000001',
    'HDFCBK-S(smsft)', received);
  assertSame('parsed', r.status);
  assertSame(received, r.tx.occurred_at, 'a date ahead of the receipt must fall back to the phone');
});

test('parser: a genuinely late sms still wins', async () => {
  // The other half of the rule must keep working: dated EARLIER by more than
  // two days means the message was delayed, so the SMS date is the truth.
  const received = Math.floor(Date.parse('2025-10-08 09:00:00 +05:30') / 1000);
  const r = await testParser().parse(
    'Sent Rs.99.00\nFrom HDFC Bank A/C *1001\nTo INDIGO SALON\nOn 02/10/25\nRef 100000000099',
    'HDFCBK-S(smsft)', received);
  assertSame(Math.floor(Date.parse('2025-10-02 12:00:00 +05:30') / 1000), r.tx.occurred_at,
    'a late SMS is filed at local noon on its own date');
});
