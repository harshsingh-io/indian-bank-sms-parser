/**
 * Integer paise, never floats.
 *
 * One place for the conversion, so no caller is tempted to reach for a float.
 */

/**
 * Convert an amount as written in an SMS to integer paise.
 *
 * Handles Indian digit grouping ("1,23,456.78"), a bare integer ("180"), and a
 * single decimal place ("180.5" is 180 rupees 50 paise, not 5).
 */
export function toPaise(amount: string): number {
  const clean = String(amount).trim().replace(/[,\s₹]|Rs\.?|INR/gi, '');
  const m = clean.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!clean || !m) throw new Error(`not an amount: ${amount}`);
  const rupees = Number(m[1]);
  // "180.5" means 50 paise, so pad on the right, not the left.
  const paise = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return rupees * 100 + paise;
}

/** Same as toPaise, but null instead of throwing. */
export function tryToPaise(amount: string | null | undefined): number | null {
  if (amount === null || amount === undefined) return null;
  try {
    return toPaise(amount);
  } catch {
    return null;
  }
}

/** Render paise for display: 18000 becomes "180.00". */
export function format(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const n = Math.abs(paise);
  return `${sign}${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}
