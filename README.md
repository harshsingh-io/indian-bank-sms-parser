# indian-bank-sms-parser

Turn an Indian bank or wallet SMS into a structured transaction.

```
Sent Rs.1,250.50
From HDFC Bank A/C *1001
To payee1@okhdfcbank
On 03/10/25
Ref 100000000002
```
↓
```json
{
  "status": "parsed",
  "profile": "hdfc/hdfc-upi-debit",
  "tx": {
    "amount_paise": 125050,
    "direction": "debit",
    "channel": "upi",
    "account_hint": "1001",
    "payee_raw": "payee1@okhdfcbank",
    "vpa": "payee1@okhdfcbank",
    "ref": "100000000002",
    "occurred_at": 1759499520
  }
}
```

**Zero dependencies.** Bank behaviour lives in JSON, not code. Runs wherever
`fetch` and `Intl` do — Node, Bun, Deno, Cloudflare Workers, the browser.

---

## Why this exists

Every expense tracker in India reads your SMS, because that is the only
universal transaction feed the banks give you. On Android an app can request
`READ_SMS` and do it directly. **On iOS no app can read SMS at all**, which is
why iPhone users in India are stuck entering expenses by hand or handing their
messages to someone else's server.

The workaround is an iOS Shortcuts automation: a *Message* automation fires on
arrival, posts the text to an endpoint you control, and something at the other
end has to turn `Sent Rs.1,250.50 From HDFC Bank A/C *1001...` into a
transaction. **This package is that something.** It is extracted from a working
self-hosted tracker and has parsed around 1,800 real messages.

It does one job and holds no opinions about storage, categories or UI.

## Install

```bash
npm install indian-bank-sms-parser
```

Needs Node 22.6+ for native TypeScript, or any bundler. See
[Running it](#running-it) for older Node.

## Use

```js
import { createParser } from 'indian-bank-sms-parser';

const parser = createParser();
const result = await parser.parse(smsText, 'VM-HDFCBK', receivedAtEpochSeconds);

if (result.status === 'parsed') {
  console.log(result.tx.amount_paise, result.tx.direction, result.tx.payee_raw);
}
```

### What comes back

| `status` | meaning |
| --- | --- |
| `parsed` | `result.tx` holds the transaction |
| `ignored` | deliberately not a transaction; see `ignore_reason` |
| `unparsed` | nothing matched — keep the text and write a profile |

`ignore_reason` is one of `otp`, `not_transaction` (a balance reply, a mandate
notice, a failed payment), or `sender_not_allowed`.

Every result also carries `hash`, a SHA-256 of the normalised text and sender,
so the same message arriving twice is cheap to detect.

### Money is integer paise, always

`amount_paise` is an integer. `"1,234.50"` becomes `123450`, never `1234.5`.
Floating point and money do not mix, and `0.1 + 0.2` is the reason.

```js
import { toPaise, format } from 'indian-bank-sms-parser';
toPaise('1,234.50');   // 123450
toPaise('180');        // 18000
toPaise('180.5');      // 18050  — padded right, not left
format(123450);        // "1234.50"
```

## Banks included

| Profile | Covers |
| --- | --- |
| `hdfc` | UPI, card, IMPS, ATM, mandate notices |
| `sbi` | UPI, card, cash, interest credits |
| `icici` | credit card spends, bill payments |
| `payzapp`, `phonepe`, `cred` | wallet and UPI apps |
| `axio`, `zype` | buy-now-pay-later lenders |
| `exbank` | a synthetic bank, documenting the format |

Nine profiles, 67 fixtures. **This is not a complete list of Indian banks** —
it is the set one person actually receives. Axis, Kotak, Yes, IDFC, Paytm and
others are missing and would be welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md), which is mostly "add a JSON file and a
fixture".

## Two decisions worth knowing about

**An unknown sender is refused, not guessed at.** `requireKnownSender` defaults
to `true`, so a message from a sender no profile claims comes back `ignored`.
The alternative — parsing it with whatever profile happens to match — turns one
bank's promotional text into another bank's debit. Pass `false` where the
sender genuinely is not available, as on iOS, where the Shortcuts automation is
handed the message body and no sender at all; detection then falls back to the
text.

**OTPs are dropped before anything else.** A one-time password is never parsed,
never returned, and never put in the text the caller stores. It is the first
check in the pipeline for that reason.

## Reading a balance

Many alerts quote the balance after the payment. That figure is extracted
separately and then **removed from the stored text**, so a balance never sits in
free text you did not mean to keep:

```js
import { readBalance, reconcile } from 'indian-bank-sms-parser';

readBalance('Your A/c XX1234 balance is Rs.5,000.00', false);
// { account_hint: '1234', balance_paise: 500000, via: 'balance_is' }
```

`reconcile()` compares two balance readings against the transactions between
them. A non-zero gap is the cheapest proof that capture is incomplete — the
bank's own arithmetic disagreeing with yours, which no amount of parsing
cleverness can argue with.

## Running it

```bash
npm test                     # 99 tests, no dependencies
npm test -- --bank hdfc      # one bank's fixtures while writing a profile
```

Node 22.6+ runs the `.ts` files directly through type **stripping**, which
erases types but never generates code. That rules out parameter properties,
enums, namespaces and decorators — the source avoids all four. On older Node,
or in a browser, run it through any bundler; there is nothing to configure.

## Scope

**Does:** one SMS in, one transaction out. Amount, direction, channel, account
hint, payee, VPA, reference, timestamp. Balances. Deduplication hashing.

**Does not:** store anything, categorise anything, resolve merchants, talk to a
bank, or handle currencies other than INR. A foreign-currency charge is skipped
rather than recorded at the wrong amount.

## Licence

MIT.
