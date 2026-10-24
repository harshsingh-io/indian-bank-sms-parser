/**
 * Turn an Indian bank SMS into a structured transaction.
 *
 * The nine shipped profiles are bundled, so the common case needs no setup:
 *
 *     import { createParser } from 'indian-bank-sms-parser';
 *     const parser = createParser();
 *     const r = await parser.parse(smsText, 'VM-HDFCBK', Date.now() / 1000);
 *
 * Everything a bank is allowed to vary lives in JSON, never in code, so
 * supporting a new one means adding a file and a fixture. See CONTRIBUTING.md.
 */
import axio from './profiles/banks/axio.json' with { type: 'json' };
import cred from './profiles/banks/cred.json' with { type: 'json' };
import exbank from './profiles/banks/exbank.json' with { type: 'json' };
import hdfc from './profiles/banks/hdfc.json' with { type: 'json' };
import icici from './profiles/banks/icici.json' with { type: 'json' };
import payzapp from './profiles/banks/payzapp.json' with { type: 'json' };
import phonepe from './profiles/banks/phonepe.json' with { type: 'json' };
import sbi from './profiles/banks/sbi.json' with { type: 'json' };
import zype from './profiles/banks/zype.json' with { type: 'json' };
import generic from './profiles/generic.json' with { type: 'json' };

import { Parser, type Profile, type ParserOptions } from './parser.ts';

export { Parser } from './parser.ts';
export type {
  Profile, Template, ParsedTx, ParseResult, ParserOptions,
} from './parser.ts';
export { toPaise, tryToPaise, format } from './money.ts';
export { readBalance, reconcile } from './balance.ts';
export type { BalanceReading, Reconciliation, Movement } from './balance.ts';
export { compile as compilePattern } from './regex.ts';

/**
 * Every profile that ships with this package.
 *
 * `exbank` is a worked example rather than a real bank: it documents the
 * profile format and is excluded from sender-less detection by its `example`
 * flag, so it can never claim a real message.
 */
export const BANK_PROFILES: Profile[] = [
  axio, cred, exbank, hdfc, icici, payzapp, phonepe, sbi, zype,
] as unknown as Profile[];

export const GENERIC_PROFILE: Profile = generic as unknown as Profile;

export interface CreateOptions extends ParserOptions {
  /** Extra profiles, checked before the bundled ones. */
  profiles?: Profile[];
  /** Pass false to drop the generic fallback entirely. */
  useGeneric?: boolean;
}

/**
 * A parser with the bundled profiles loaded.
 *
 * `requireKnownSender` defaults to TRUE, which is the safe setting and the
 * surprising one. An SMS from a sender no profile claims is returned
 * `ignored` with reason `sender_not_allowed`, not parsed on a guess: reading a
 * stranger's message with whatever profile happens to match turns one bank's
 * promotional text into another bank's debit.
 *
 * Set it false only where the sender is genuinely unavailable, as on iOS,
 * where the Shortcuts automation that captures a message is given no sender
 * property at all. Detection then falls back to the message body.
 */
export function createParser(opts: CreateOptions = {}): Parser {
  const { profiles = [], useGeneric = true, ...rest } = opts;
  return new Parser(
    [...profiles, ...BANK_PROFILES],
    useGeneric ? GENERIC_PROFILE : null,
    rest,
  );
}
