# Adding a bank

Most contributions are one JSON file and one fixture. No code.

## Before anything else: never send a real SMS

A bank alert contains your account digits, a reference number, who you paid
and how much. **Fixtures must be synthetic or masked.** Git history is
permanent and scrubbing later is not an option, so the masking has to happen
before the file is written, not before the pull request.

Replace, keeping each value consistent across your fixtures so the same payee
stays the same payee:

| Real | Use |
| --- | --- |
| account digits | `1001`, `1002` |
| a person or merchant | `A PAYEE`, `EXAMPLE STORE` |
| a VPA | `payee1@okexbank` |
| a reference | `100000000001` |
| a phone number | `7308080808` |
| amounts | round them; they are not identifying, but they are yours |

`src/profiles/banks/exbank.json` is a synthetic bank written to document the
format. Read it first.

## 1. Write the profile

Create `src/profiles/banks/<bank>.json`:

```json
{
  "id": "yourbank",
  "senders": ["YBANK", "YBNKAL"],
  "templates": [
    {
      "id": "yourbank-upi-debit",
      "detect": "(?i)debited.*UPI",
      "direction": "debit",
      "channel": "upi",
      "fields": {
        "amount":  "(?i)Rs\\.?\\s*([\\d,]+(?:\\.\\d{1,2})?)",
        "account": "(?i)A/c\\s*[Xx*]*(\\d{3,6})",
        "payee":   "(?i)\\bto\\s+(\\S+)",
        "ref":     "(?i)Ref(?:\\s*no)?\\.?\\s*(\\d{6,})"
      }
    }
  ]
}
```

`senders` matches as a substring against the SMS sender, so `YBANK` covers
`VM-YBANK`, `AD-YBANK-S` and the rest.

Anchor patterns to what the message actually looks like. `(?im)^To\s+(.+)$`
is right for a bank that puts the payee on its own line and captures nothing
at all for one that writes `... to someone@upi ...` inline. Most of the time a
pattern that "does not work" is anchored for a layout the bank does not use.

### Patterns are PCRE-shaped

Write a leading inline flag group — `(?i)` or `(?im)` — and a shim lifts it
into real `RegExp` flags. This keeps the patterns copy-pasteable between
languages, and the shim is verified identical to PHP's PCRE across every
shipped pattern. Do not rewrite them into JavaScript-native form.

A pattern that does not compile never matches and never throws. That is
deliberate: one malformed profile must not take the whole parser down.

### Order matters

Templates are tried in order and the first `detect` that matches wins, so the
specific must come before the general. A "failed payment" notice has to be
caught before the ordinary debit template sees it, or a payment that never
happened is recorded as spending.

## 2. Write fixtures

One file per message shape, in `tests/fixtures/<bank>/`:

```json
{
  "name": "upi debit to a person",
  "sender": "VM-YBANK",
  "received_at": "2026-05-01 19:22:00 +05:30",
  "text": "Rs.1,250.50 debited from A/c *1001 to payee1@okexbank UPI Ref 100000000001",
  "expect": {
    "status": "parsed",
    "direction": "debit",
    "channel": "upi",
    "amount_paise": 125050,
    "account": "1001",
    "payee": "payee1@okexbank",
    "ref": "100000000001"
  }
}
```

The runner rejects an `expect` key it does not recognise rather than skipping
it. A profile written against `account_hint` instead of `account` shipped
twice before that guard existed, with every fixture passing and nothing
asserted.

Cover the shapes the bank actually sends, where it sends them:

- UPI debit to a merchant, and to a person
- card spend
- a credit
- a refund or reversal
- ATM withdrawal
- a mandate or auto-debit **notice** — expect `ignored`, since the money has
  not moved yet
- a failed payment — expect `ignored`
- an OTP — expect `ignored` with reason `otp`

## 3. Run it

```bash
npm test -- --bank yourbank    # just yours, while iterating
npm test                       # everything, before opening the PR
```

Both must pass. There are no dependencies to install.

## What makes a change easy to accept

- **Bank behaviour belongs in JSON.** A change to `src/*.ts` to support one
  bank is a sign the profile format is missing something — say so in the
  issue and we will extend the format instead.
- **Money stays integer paise.** No floats anywhere, including in a test.
- **An ambiguous message is ignored, not guessed.** Recording a transaction
  that did not happen is worse than recording nothing: a missing row is
  visible, a wrong one is not.
- Node's type stripping erases types but generates no code, so no parameter
  properties, enums, namespaces or decorators.

## Reporting a bank that parses wrongly

Open an issue with the **masked** message, what you expected, and what you
got. Masked. Every time.
