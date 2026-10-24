/**
 * Masking a bank SMS so it can be shared as a test fixture.
 */

/**
 * Replace everything that identifies a person or an account.
 *
 * Two rules, learned the hard way on the first version of this:
 *
 * SHAPE IS THE POINT. A fixture exists to preserve where the amount sits,
 * how the payee is introduced, which words separate the fields. An eager
 * name-matcher turned "Dear Customer, ... Kotak Bank A/c ... on 23-Oct-26"
 * into "PAYEE 4, ... PAYEE 5/c ... on 23-PAYEE 6-26" -- every real value
 * gone, and the message no longer resembling anything a bank sends. So names
 * are masked only where a name actually belongs: after a payee marker, or in
 * the payee slot of a UPI narration. Everything else is reported instead, for
 * a human to look at.
 *
 * SUBSTITUTE ONCE. Each match becomes a placeholder immediately and is
 * restored at the end, because a later rule otherwise eats an earlier rule's
 * output -- the phone number became 7308080808 and the reference rule, seeing
 * ten digits, promptly renumbered it.
 */
export function mask(input: string): { text: string; leftover: string[] } {
  const slots = [];
  const hold = (value) => { slots.push(value); return `\u0000${slots.length - 1}\u0000`; };
  const seen = new Map();
  const nth = (kind, key, make) => {
    const id = `${kind}:${key}`;
    if (!seen.has(id)) seen.set(id, make([...seen.keys()].filter((k) => k.startsWith(kind)).length + 1));
    return seen.get(id);
  };
  let t = input;

  // A VPA, before anything else can eat its digits.
  t = t.replace(/\b[A-Za-z0-9][A-Za-z0-9._-]{1,}@[A-Za-z][A-Za-z0-9.]{1,}\b/g,
    (m) => (/\.(com|in|org|net)$/i.test(m) ? m
      : hold(nth('vpa', m, (n) => `payee${n}@okexbank`))));

  // A name in the payee slot of a UPI narration: UPI/DR/<ref>/<NAME>/<BANK>.
  t = t.replace(/\b(UPI\/(?:DR|CR)\/)(\d{6,})(\/)([^/\n]{2,40})(\/)/gi,
    (_m, head, ref, s1, name, s2) =>
      head + hold(nth('ref', ref, (n) => String(100000000000 + n))) + s1
      + hold(nth('name', name.toUpperCase(), (n) => (n === 1 ? 'A PAYEE' : `PAYEE ${n}`))) + s2);

  // A name after the word that introduces one -- but "towards UPI/DR/..."
  // introduces a rail, not a person, and masking the word UPI destroys the
  // one token a profile will match on.
  const NOT_A_NAME = /^(UPI|IMPS|NEFT|RTGS|ATM|POS|VPA|A|Ac|Your|Account|Card|Bank|The|This|Rs|INR)$/i;
  t = t.replace(/\b((?:trf\s+to|paid\s+to|sent\s+to|towards|to)\s+)([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,3})\b/g,
    (m, lead, name) => (NOT_A_NAME.test(name.split(/\s+/)[0]) ? m
      : lead + hold(nth('name', name.toUpperCase(),
        (n) => (n === 1 ? 'A PAYEE' : `PAYEE ${n}`)))));

  // Masked account digits keep their mask character: XX1234, *1234, x1234.
  t = t.replace(/\b([Xx*]{1,6})(\d{3,6})\b/g,
    (_m, x, d) => x + hold(nth('acct', d, (n) => String(1000 + n))));

  // A ten-digit mobile.
  t = t.replace(/(?<!\d)[6-9]\d{9}(?!\d)/g, () => hold('7308080808'));

  // Any long digit run left is a reference. Helplines are public and stay,
  // so the message still reads like the bank wrote it.
  t = t.replace(/(?<!\d)\d{6,}(?!\d)/g, (m) =>
    (/^(1800|1860|1900)/.test(m) ? m : hold(nth('ref', m, (n) => String(100000000000 + n)))));

  // Amounts keep their grouping and decimals: "1,23,456.78" -> "1,11,111.11",
  // so a pattern that reads Indian digit grouping is still exercised.
  t = t.replace(/(?<=Rs\.?\s*|INR\s*|\u20B9\s*)([\d,]+(?:\.\d{1,2})?)/gi,
    (m) => hold(m.replace(/\d/g, '1')));

  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => slots[Number(i)]);

  // Whatever is still a capitalised run might be a name this did not reach.
  const KEEP = /^(UPI|IMPS|NEFT|RTGS|ATM|POS|VPA|OTP|INR|Rs|A|Ac|Bank|Card|Credit|Debit|Avl|Bal|Limit|Ref|Not|You|Call|SMS|Block|To|From|On|By|For|The|And|Dear|Customer|User|Trf|Date|Info|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|HDFC|SBI|ICICI|Axis|Kotak|Yes|IDFC|PNB|BOB|Canara|Union|IndusInd|Federal|RBL|AU|DBS|HSBC|Citi|Amex|Paytm|PhonePe|GPay|Amazon|CRED)$/i;
  const leftover = [...new Set((t.match(/\b[A-Z][A-Za-z]{2,}\b/g) ?? []).filter((w) => !KEEP.test(w)))];
  return { text: t, leftover };
}
