/**
 * SMS parsing against bank profiles.
 *
 * Profiles are JSON so a bank is a data change, never a code change. The
 * pipeline order is load-bearing and is followed exactly: normalize,
 * drop OTPs, choose profile, sender check, ignore rules, extract, generic
 * fallback, balance-alert check, unparsed.
 */
import { capture, test as reTest } from './regex.ts';
import { readBalance, type BalanceReading } from './balance.ts';
import { tryToPaise } from './money.ts';

export interface Template {
  id: string;
  detect: string;
  direction: string;
  channel?: string | null;
  ignore?: { pattern: string; reason?: string }[];
  fields?: Record<string, string>;
  date_format?: string;
}
export interface Profile {
  id: string;
  bank?: string;
  senders?: string[];
  /**
   * A synthetic profile that exists only for fixtures. It still matches when
   * its own sender is named, but never competes to identify an unknown sender
   * -- its templates are deliberately generic, and sorting by id put
   * `exbank` ahead of `hdfc`, so every sender-less message was filed as the
   * example bank.
   */
  example?: boolean;
  generic_fallback?: boolean;
  ignore?: { pattern: string; reason?: string }[];
  templates?: Template[];
}
export interface ParsedTx {
  direction: string;
  channel: string | null;
  amount_paise: number;
  account_hint: string | null;
  payee_raw: string | null;
  vpa: string | null;
  ref: string | null;
  occurred_at: number;
}
export interface ParseResult {
  status: 'parsed' | 'ignored' | 'unparsed';
  ignore_reason: string | null;
  profile: string | null;
  bank_id: string | null;
  generic: boolean;
  text: string;
  hash: string;
  tx: ParsedTx | null;
  /**
   * A balance the bank reported, read BEFORE the figure is stripped from the
   * text. The message is still scrubbed; only this field keeps the number.
   */
  balance: BalanceReading | null;
}

/**
 * Ignore rules that hold for every bank, as opposed to a profile's own. These
 * are facts about Indian bank SMS rather than per-bank configuration.
 */
const GLOBAL_IGNORE: { pattern: RegExp; reason: string }[] = [
  // "Rs 199 will be debited on 05/10" is a mandate notice, not a payment.
  { pattern: /\b(will\s+(be|always\s+be)\s+(auto-?\s*)?(debited|deducted|charged)|is\s+due\s+for\s+payment|e-?mandate|standing\s+instruction)\b/i,
    reason: 'pre_debit_notice' },
  // A UPI collect request is money someone is ASKING for. Approving one emits
  // its own debit SMS, and most are never approved at all.
  { pattern: /\b(has\s+requested\s+(a\s+payment\s+of\s+)?(money|Rs\.?\s?[\d,]|INR)|sent\s+you\s+an\s+AutoPay\s+request)/i,
    reason: 'pre_debit_notice' },
  // A payment that did not happen must never become a transaction.
  { pattern: /\b(failed|declined|unsuccessful|was\s+not\s+successful|could\s+not\s+be\s+processed|has\s+been\s+rejected)\b/i,
    reason: 'failed' },
  // Marketing. Narrow on purpose: a real credit can mention "cashback".
  { pattern: /\b(click\s+here|apply\s+now|t&c\s+apply|terms\s+apply|unsubscribe|pre-?approved|lowest\s+interest)\b/i,
    reason: 'not_transaction' },
  // Statements and bill reminders quote amounts that were never moved.
  { pattern: /\b(amount\s+due\s+of|is\s+due\s+by|statement\s+is\s+sent|minimum\s+(amount\s+)?due)\b/i,
    reason: 'not_transaction' },
  // Mandate lifecycle events, as opposed to a mandate actually executing.
  { pattern: /\bmandate\b[^\n]*\b(is\s+successfully\s+)?(created|registered|cancelled|canceled|revoked|paused)\b/i,
    reason: 'not_transaction' },
  // Multi-currency is out of scope. Ignoring a foreign charge loses one
  // transaction; parsing it does far worse, because the rupee amount pattern
  // then matches the credit limit further along and records a ~500 rupee
  // charge as 86,950.
  { pattern: /\b(USD|EUR|GBP|AED|SGD|AUD|CAD|JPY|CHF|THB|MYR)\s?[\d,]+(?:\.\d{1,2})?\s+(spent|debited|charged|withdrawn)\b/i,
    reason: 'foreign_currency' },
];

/** Words that make a message an OTP, which is never stored. */
const OTP_PATTERN =
  /\b(otp|one[\s-]?time[\s-]?(password|passcode|pin)|verification\s+code|security\s+code|access\s+code|login\s+code)\b/i;

/** Movement words. A message with none of these is a balance alert. */
const MOVEMENT_PATTERN =
  /\b(debited|credited|sent|spent|paid|withdrawn|received|transferred|purchase|txn|transaction|refund)\b/i;

export interface ParserOptions {
  storeBalance?: boolean;
  requireKnownSender?: boolean;
  timezone?: string;
}

export class Parser {
  private banks: Profile[];
  private generic: Profile | null;
  private storeBalance: boolean;
  private requireKnownSender: boolean;
  private tz: string;

  constructor(banks: Profile[], generic: Profile | null, opts: ParserOptions = {}) {
    // Deterministic order, so "first matching template wins" is reproducible.
    this.banks = [...banks].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    this.generic = generic;
    this.storeBalance = opts.storeBalance ?? false;
    this.requireKnownSender = opts.requireKnownSender ?? true;
    this.tz = opts.timezone ?? 'Asia/Kolkata';
  }

  /**
   * Normalize an SMS for matching and hashing.
   *
   * The rule is to collapse whitespace, but field patterns anchor to line starts
   * (`(?im)^To\s+...`), so newlines are structure and are preserved. Only
   * horizontal whitespace is collapsed.
   */
  static normalize(text: string): string {
    let t = text.replace(/\r\n|\r/g, '\n');
    // Unify currency markers. Requiring a digit ahead is deliberate: "\bRs\b"
    // cannot match "Rs274.0", because a digit leaves no word boundary after the
    // "s", and such amounts were unreadable to every profile.
    t = t.replace(/(?:₹|\bINR|\bRs)\.?\s*(?=\d)/gi, 'Rs.');
    t = t.replace(/[^\S\n]+/g, ' ');   // spaces and tabs, not newlines
    t = t.replace(/ *\n */g, '\n');    // trim each line
    t = t.replace(/\n{2,}/g, '\n');    // collapse blank lines
    return t.trim();
  }

  static async hash(normalizedText: string, sender: string | null): Promise<string> {
    const data = new TextEncoder().encode(`${normalizedText}|${String(sender ?? '').trim().toUpperCase()}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  static isOtp(text: string): boolean {
    return OTP_PATTERN.test(text);
  }

  /** Strip balance fragments unless the caller opted to keep them. */
  static stripBalance(text: string): string {
    // Precise forms first, so the line-eating fallback rarely has to fire. A
    // credit card's "Avl Limit" is as private as a balance, and both are
    // written a dozen ways.
    const patterns = [
      /\b(avl|available|avbl|a\/v)\.?\s*(bal|balance|limit|lmt)\s*[:.]?\s*Rs\.\s*[\d,]+(?:\.\d{1,2})?/gi,
      /\bbal(?:ance)?\s*(?:is|:|\.)?\s*Rs\.\s*[\d,]+(?:\.\d{1,2})?/gi,
      /\b(avl|available|avbl|a\/v)\.?\s*(bal|balance|limit|lmt)\b[^\n]*/gi,
      /\bclear\s+bal(ance)?\b[^\n]*/gi,
    ];
    let t = text;
    for (const p of patterns) t = t.replace(p, '');
    t = t.replace(/ *\n */g, '\n').replace(/[ ,.;-]+\n/g, '\n').replace(/\n{2,}/g, '\n');
    return t.trim().replace(/[ ,.;-]+$/, '');
  }

  async parse(rawText: string, sender: string | null, receivedAt: number): Promise<ParseResult> {
    const text = Parser.normalize(rawText);
    const result: ParseResult = {
      status: 'unparsed',
      ignore_reason: null,
      profile: null,
      bank_id: null,
      generic: false,
      text: this.storeBalance ? text : Parser.stripBalance(text),
      hash: await Parser.hash(text, sender),
      tx: null,
      // Read from the ORIGINAL text, before the line above scrubs the figure
      // out of it. A message that also describes money moving is refused, so a
      // debit alert quoting its resulting balance stays one event, not two.
      balance: readBalance(text, MOVEMENT_PATTERN.test(text)),
    };

    // 2. OTPs are dropped before anything else and never stored.
    if (Parser.isOtp(text)) return { ...result, status: 'ignored', ignore_reason: 'otp' };

    // 3. Choose a bank profile by sender, then by detect pattern.
    const bank = this.chooseBank(text, sender);

    // 4. Sender allowlist. Blocks a fake "Rs 5000 debited" from a random number.
    if (!bank && this.requireKnownSender && String(sender ?? '').trim() !== '') {
      return { ...result, status: 'ignored', ignore_reason: 'sender_not_allowed' };
    }

    // 5. Global ignore rules apply whether or not a bank matched.
    for (const rule of GLOBAL_IGNORE) {
      if (rule.pattern.test(text)) return { ...result, status: 'ignored', ignore_reason: rule.reason };
    }

    if (bank) {
      // 6. Bank-level ignores, for noise this bank sends that matches no
      //    template at all. Without these such messages pile up as `unparsed`
      //    and bury the genuine parse failures.
      const bankReason = ignoreReason(bank.ignore, text);
      if (bankReason) return { ...result, status: 'ignored', ignore_reason: bankReason };

      // 7. Each template of the chosen bank, in file order.
      for (const t of bank.templates ?? []) {
        if (!reTest(t.detect, text)) continue;
        const reason = ignoreReason(t.ignore, text);
        if (reason) return { ...result, status: 'ignored', ignore_reason: reason };
        const tx = this.extract(t, text, receivedAt);
        if (tx) {
          return { ...result, status: 'parsed', bank_id: bank.id, profile: `${bank.id}/${t.id}`, tx };
        }
      }
    }

    // 8. Generic fallback, unless the profile opted out. For a bank the
    //    fallback is a safety net; for a wallet whose traffic is mostly
    //    marketing it invents transactions, so those profiles set
    //    "generic_fallback": false.
    const allowGeneric = !bank || bank.generic_fallback !== false;
    if (this.generic && allowGeneric) {
      for (const t of this.generic.templates ?? []) {
        if (!reTest(t.detect, text)) continue;
        if (ignoreReason(t.ignore, text)) continue;
        const tx = this.extract(t, text, receivedAt);
        if (tx) {
          return { ...result, status: 'parsed', generic: true, bank_id: 'generic', profile: `generic/${t.id}`, tx };
        }
      }
    }

    // 9. A bare balance alert, decided only now that every template has
    //    declined. Asking up front means guessing "did money move?" from a word
    //    list, and the word list loses: "has credit for UPI/REVERSAL ... Avl Bal"
    //    is a real reversal but says `credit`, not `credited`.
    if (/\b(avl|available|avbl)\.?\s*(bal|balance)\b/i.test(text) && !MOVEMENT_PATTERN.test(text)) {
      return { ...result, status: 'ignored', ignore_reason: 'not_transaction' };
    }

    return result;
  }

  private chooseBank(text: string, sender: string | null): Profile | null {
    const s = String(sender ?? '').trim().toUpperCase();
    if (s !== '') {
      // Indian sender IDs look like AX-EXBANK-S, so match on substring.
      for (const bank of this.banks) {
        for (const code of bank.senders ?? []) {
          if (code && s.includes(String(code).toUpperCase())) return bank;
        }
      }
      return null;
    }
    // No sender at all, which is the normal case from the phone: iOS exposes no
    // Sender property to a shortcut, so the body is all there is to go on.
    for (const bank of this.banks) {
      if (bank.example) continue;
      for (const t of bank.templates ?? []) if (reTest(t.detect, text)) return bank;
    }
    return null;
  }

  /** Pull the fields a template declares. `amount` is required. */
  private extract(t: Template, text: string, receivedAt: number): ParsedTx | null {
    const f = t.fields ?? {};
    const paise = tryToPaise(capture(f.amount, text, 'amount'));
    if (paise === null || paise <= 0) return null;

    const payee = capture(f.payee, text, 'payee');
    const vpa = capture(f.vpa, text, 'vpa');
    return {
      direction: t.direction ?? 'debit',
      channel: t.channel ?? null,
      amount_paise: paise,
      account_hint: capture(f.account, text, 'account'),
      payee_raw: payee ? payee.trim() : null,
      vpa: vpa ? vpa.trim().toLowerCase() : null,
      ref: capture(f.ref, text, 'ref'),
      occurred_at: this.occurredAt(t, f, text, receivedAt),
    };
  }

  /**
   * When the payment happened.
   *
   * The phone's receipt time is normally right. When the date inside the SMS is
   * more than two days EARLIER, the message arrived late, so trust the SMS and
   * place it at local noon.
   *
   * An SMS date LATER than the receipt is never trusted, however far out. A
   * message cannot describe a payment that has not happened yet, so that is the
   * bank getting its own date wrong -- real HDFC messages say "On 28/12/26"
   * while arriving in December 2025. Taking them at face value files a year of
   * ordinary spending in the future, where no statement will ever match it.
   */
  private occurredAt(t: Template, f: Record<string, string>, text: string, receivedAt: number): number {
    const raw = capture(f.date, text, 'date');
    if (!raw || !t.date_format) return receivedAt;
    const parsed = parseByFormat(raw.trim(), t.date_format, this.tz);
    if (parsed === null) return receivedAt;

    const receivedMidnight = startOfLocalDay(receivedAt, this.tz);
    const drift = receivedMidnight - parsed;          // positive when the SMS is older
    if (drift <= 2 * 86400) return receivedAt;        // in step, or dated ahead: trust the phone
    return parsed + 12 * 3600;                        // genuinely late: local noon of the SMS date
  }
}

function ignoreReason(rules: { pattern: string; reason?: string }[] | undefined, text: string): string | null {
  for (const r of rules ?? []) {
    if (r.pattern && reTest(r.pattern, text)) return r.reason ?? 'not_transaction';
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse a date written in one of the handful of shapes Indian banks use,
 * described with PHP-style format letters so profiles stay unchanged.
 *
 * Returns the UTC epoch of local midnight on that date, or null.
 */
export function parseByFormat(value: string, format: string, tz: string): number | null {
  // Build a regex from the format letters, capturing each component.
  let re = '';
  const order: string[] = [];
  for (const ch of format) {
    if (ch === 'd') { re += '(\\d{2})'; order.push('d'); }
    else if (ch === 'j') { re += '(\\d{1,2})'; order.push('d'); }
    else if (ch === 'm') { re += '(\\d{2})'; order.push('m'); }
    else if (ch === 'n') { re += '(\\d{1,2})'; order.push('m'); }
    else if (ch === 'M') { re += '([A-Za-z]{3})'; order.push('M'); }
    else if (ch === 'y') { re += '(\\d{2})'; order.push('y'); }
    else if (ch === 'Y') { re += '(\\d{4})'; order.push('Y'); }
    else re += ch.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  }
  const m = value.match(new RegExp(`^${re}$`));
  if (!m) return null;

  let day = 1, month = 1, year = 1970;
  order.forEach((kind, i) => {
    const v = m[i + 1];
    if (kind === 'd') day = Number(v);
    else if (kind === 'm') month = Number(v);
    else if (kind === 'M') month = MONTHS[v.toLowerCase()] ?? 0;
    else if (kind === 'y') year = 2000 + Number(v);
    else if (kind === 'Y') year = Number(v);
  });
  if (!month || month > 12 || !day || day > 31) return null;

  // Local midnight -> UTC epoch, using the zone's offset on that date.
  const guess = Date.UTC(year, month - 1, day) / 1000;
  return guess - tzOffsetSeconds(guess, tz);
}

/** Offset of `tz` from UTC, in seconds, at the given instant. */
export function tzOffsetSeconds(epoch: number, tz: string): number {
  const d = new Date(epoch * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) / 1000;
  return asUtc - epoch;
}

export function startOfLocalDay(epoch: number, tz: string): number {
  const off = tzOffsetSeconds(epoch, tz);
  const local = epoch + off;
  return Math.floor(local / 86400) * 86400 - off;
}
