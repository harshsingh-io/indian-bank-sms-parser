/**
 * Reading an account balance out of a bank SMS.
 *
 * Every Indian bank answers a balance request by SMS — HDFC to 5676712, SBI
 * to 09223766666, ICICI to 9215676766 — and the reply lands in the same
 * capture pipeline as everything else. Today the parser recognises those
 * messages and discards them as `not_transaction`, with the figure stripped
 * before storage.
 *
 * The figure is worth keeping, and keeping it does not require keeping the
 * text. Balances are extracted here, stored in their own column, and the raw
 * message is scrubbed exactly as before — so no balance ever sits in free
 * text, which is what that rule protects against.
 *
 * What a balance buys is proof. Two balances for one account, and the
 * transactions recorded between them, must agree. When they do not, a message
 * was missed — and for an account that sends SMS for only a fraction of its
 * activity, that is the only cheap way to know.
 */

export interface BalanceReading {
  account_hint: string | null;
  balance_paise: number;
  /** Which phrasing matched, kept so a misread can be traced to a pattern. */
  via: string;
}

/**
 * Amount to integer paise by string arithmetic. Never a float: `0.1 + 0.2`
 * is the reason money is counted in whole paise everywhere.
 */
function toPaise(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

// Ordered: the most explicit phrasing first, so a vaguer pattern never claims
// a message a precise one would have read correctly.
const PATTERNS: { name: string; re: RegExp }[] = [
  // A bounded gap between the label and the figure, because banks write
  // "Avl Limit on Card XX0000 is Rs.1,50,000" as readily as "Avl Bal Rs.500".
  // Bounded, not greedy: an unlimited gap starts finding a later amount.
  // "[\d,]+" also covers Indian grouping, 1,50,000 being 150000 rupees.
  // "Your A/c XX1234 balance is Rs.1,234.50" / "Avl Bal Rs 1234.50"
  { name: 'avl_bal', re: /\b(?:avl|available|avbl|a\/v)\.?\s*bal(?:ance)?\b[^\n]{0,40}?(?:₹|INR|Rs)\.?\s*([\d,]+(?:\.\d{1,2})?)/i },
  { name: 'balance_is', re: /\bbal(?:ance)?\s*(?:is|:|-)[^\n]{0,40}?(?:₹|INR|Rs)\.?\s*([\d,]+(?:\.\d{1,2})?)/i },
  // SBI answers "Your A/c X4338-Rs.1,234.50"
  { name: 'account_dash', re: /\bA\/c\s*[Xx*]*\d{3,}\s*[-:]\s*(?:₹|INR|Rs)\.?\s*([\d,]+(?:\.\d{1,2})?)/i },
  // Credit cards report headroom rather than a balance.
  { name: 'avl_limit', re: /\b(?:avl|available)\.?\s*(?:limit|lmt)\b[^\n]{0,40}?(?:₹|INR|Rs)\.?\s*([\d,]+(?:\.\d{1,2})?)/i },
];

const ACCOUNT = /\b(?:A\/c|A\/C|Acct|Account|Card)\s*(?:no\.?)?\s*[Xx*]{0,6}(\d{3,6})\b/i;

/**
 * Read a balance from a message, or return null.
 *
 * Deliberately refuses a message that also describes money moving: a debit
 * alert quoting the resulting balance is a transaction first, and recording
 * its balance as a standalone reading would double-count the event.
 */
export function readBalance(text: string, hasMovement: boolean): BalanceReading | null {
  if (!text || hasMovement) return null;
  for (const { name, re } of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const paise = toPaise(m[1]);
    if (paise === null) continue;
    const acct = ACCOUNT.exec(text);
    return { account_hint: acct ? acct[1] : null, balance_paise: paise, via: name };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reconciling two readings against what was recorded between them
// ---------------------------------------------------------------------------

export interface Movement {
  occurred_at: number;
  amount_paise: number;
  direction: string;
}

export interface Reconciliation {
  from_at: number;
  to_at: number;
  opening_paise: number;
  closing_paise: number;
  /** Credits minus debits, from the transactions actually recorded. */
  recorded_paise: number;
  /** What the balances say actually happened. */
  observed_paise: number;
  /** observed - recorded. Negative means spending we never saw. */
  gap_paise: number;
  movements: number;
}

/**
 * Compare two balance readings against the transactions between them.
 *
 * A non-zero gap is the cheapest possible proof that capture is incomplete:
 * the bank's own arithmetic disagrees with ours, and no amount of parsing
 * cleverness can argue with it.
 */
export function reconcile(
  opening: { observed_at: number; balance_paise: number },
  closing: { observed_at: number; balance_paise: number },
  movements: Movement[],
): Reconciliation {
  const between = movements.filter(
    (m) => m.occurred_at > opening.observed_at && m.occurred_at <= closing.observed_at,
  );
  const recorded = between.reduce(
    (a, m) => a + (m.direction === 'credit' ? m.amount_paise : -m.amount_paise), 0,
  );
  const observed = closing.balance_paise - opening.balance_paise;
  return {
    from_at: opening.observed_at,
    to_at: closing.observed_at,
    opening_paise: opening.balance_paise,
    closing_paise: closing.balance_paise,
    recorded_paise: recorded,
    observed_paise: observed,
    gap_paise: observed - recorded,
    movements: between.length,
  };
}
