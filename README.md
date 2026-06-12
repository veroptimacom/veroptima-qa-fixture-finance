# veroptima-qa-fixture-finance

Finance / international identifiers fixture pack for [qa-expert](https://github.com/ricardo-hdrn) plugins. Implements `@qa-expert/fixture-pack-contract` **v0.1.0**.

This is the **`finance` domain pack** — one pack, one vertical, five kinds: credit-card PANs, IBANs, SWIFT/BIC codes, US ABA routing numbers, ISBN-13. All are international/protocol-level identifiers (not localized strings), so the pack is **locale-agnostic** (`locales: []`). All seed-deterministic. **Zero runtime dependencies beyond the contract + zod.**

## Install

Git-distributed under ADR-0027. Add to your engineer config:

```jsonc
{
  "plugins": {
    "fixtures": [
      {
        "source": "github:ricardo-hdrn/veroptima-qa-fixture-finance#main"
      }
    ]
  }
}
```

…or any URI your plugin loader supports (`git+https:`, tarball, local path).

## Kinds

| Kind | outputs | locales | params | Notes |
|---|---|---|---|---|
| `credit-card` | string | — | `{ brand?: "visa" \| "mastercard" \| "amex" \| "discover" \| "any", validity?: ValidityMode }` (default `any` / `"valid"`) | Brand-correct BIN prefix + length, Luhn check digit. |
| `iban` | string | — | `{ country: ISO-3166-alpha2, validity?: ValidityMode }` | Country-correct BBAN format + mod-97 check digits. 10 countries supported (see below); unsupported throws `unsupported-country: <CC>`. |
| `swift-bic` | string | — | `{ length?: 8 \| 11, validity?: ValidityMode }` (default `8` / `"valid"`) | 4 letters bank + 2 letters country + 2 alphanumeric location + optional 3 alphanumeric branch. No check digit. |
| `routing-number` | string | — | `{ validity?: ValidityMode }` (default `"valid"`) | 9-digit US ABA routing number, weighted-sum mod-10 = 0. |
| `isbn-13` | string | — | `{ validity?: ValidityMode }` (default `"valid"`) | 13 digits, "978-"/"979-" EAN prefix, alternating-weight (1/3) mod-10 check digit. |

`ValidityMode` lets a caller request KNOWN-INVALID variants for negative-path tests — see [Validity modes](#validity-modes).

## Supported IBAN countries

| Country | Total length | BBAN structure |
|---|---|---|
| DE | 22 | 8n bank + 10n account |
| GB | 22 | 4a bank + 6n sort + 8n account |
| FR | 27 | 5n bank + 5n branch + 11c account + 2n RIB |
| ES | 24 | 4n bank + 4n branch + 2n check + 10n account |
| IT | 27 | 1a CIN + 5n bank + 5n branch + 12c account |
| NL | 18 | 4a bank + 10n account |
| BE | 16 | 3n bank + 7n account + 2n national check |
| PT | 25 | 4n bank + 4n branch + 11n account + 2n check |
| CH | 21 | 5n bank + 12c account |
| BR | 29 | 8n bank + 5n branch + 10n account + 1a type + 1c currency-ish |

(`n` = digit, `a` = upper alpha, `c` = alphanumeric.) Any other country throws `unsupported-country: <CC>` — the binder gets a loud failure, not a silently-wrong IBAN.

## Validity modes

Each kind takes an optional `validity` param that asks for **known-invalid** variants for negative-path tests. Default is `"valid"` — every existing call site behaves byte-identically.

| Mode | Meaning |
|---|---|
| `valid` (default) | Passes every documented check. |
| `invalid-checksum` | Right length + alphabet, wrong check digit (Luhn / mod-97 / ABA / ISBN-13 mod-10). |
| `invalid-length` | Wrong character count. |
| `invalid-format` | Wrong alphabet (letter where digit expected, or digit where letter expected). |
| `invalid-prefix` | (where prefix is part of the rule) credit-card: brand-length kept, prefix doesn't match brand; isbn-13: uses "977" (ISSN region). |
| `invalid-country` | (`iban` only) two-letter country code with no shipped entry (`"XX"`). |

### Per-kind support matrix

| Kind | valid | invalid-checksum | invalid-length | invalid-format | invalid-prefix | invalid-country |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `credit-card` | ✓ | ✓ (wrong Luhn) | ✓ | ✓ (letters) | ✓ (brand-length kept, prefix "12") | — |
| `iban` | ✓ | ✓ (mod-97 ≠ 1) | ✓ | ✓ | — | ✓ ("XX", length 22) |
| `swift-bic` | ✓ (shape-only — no check digit exists) | — *throws* | ✓ | ✓ | — | — |
| `routing-number` | ✓ | ✓ (wrong ABA mod-10) | ✓ | ✓ | — | — |
| `isbn-13` | ✓ | ✓ (wrong mod-10) | ✓ | ✓ | ✓ ("977") | — |

Unsupported `(kind, mode)` pairs **throw** `unsupported-validity-mode: <mode>` — surfaces the gap, never silently falls back to `valid`. SWIFT/BIC is shape-only: no checksum exists, so `invalid-checksum` is structurally unrepresentable.

### Round-trip guarantee

Every shipped `(kind, mode)` pair is asserted to survive a real validator's reject path: the test suite reimplements each composite validator (length + alphabet + prefix + check-digit) as its own oracle and runs each invalid variant through it. `valid` mode must PASS the validator; every `invalid-*` mode must FAIL the validator. So a regression that produces a "wrong" value the validator happens to accept flips the suite red.

## Determinism

Same `(seed, validity, params, locale)` → byte-identical output, every time. The pack uses a self-contained **sfc32** PRNG seeded via **FNV-1a** over a canonicalized key (`seed | kind | locale | sorted-params-including-validity`). The default `validity: "valid"` is stripped from the seed key so existing callers see byte-identical pre-feature output. Non-default modes ARE part of the key, so each mode gets a distinct seed (and a distinct value vs the `valid` variant for the same seed). No `Math.random()`, no `Date.now()`, no `crypto.randomUUID()`. The test suite asserts this via cross-call replay on every (kind, mode) pair.

## Correctness (the moat)

Every check-digit algorithm is reimplemented inside the test file as an independent oracle, so a regression in `src/index.ts` is detected even if the source code is internally self-consistent:

- **Luhn (credit-card)** — standard mod-10 right-to-left "double every second digit" algorithm. Verified against the canonical test PANs `4111 1111 1111 1111` (Visa), `3782 822463 10005` (Amex).
- **IBAN mod-97** — ISO 13616 algorithm: move first 4 chars to end, expand letters (A=10..Z=35), one BigInt mod 97 must equal 1. Verified against `DE89 3704 0044 0532 0130 00`, `GB82 WEST 1234 5698 7654 32`, `FR14 2004 1010 0505 0001 3M02 606`.
- **ABA mod-10 weighted (routing-number)** — weights `[3,7,1]` repeated, sum mod 10 = 0. Verified against `121000248` (Wells Fargo CA), `021000021` (Chase NY).
- **ISBN-13** — alternating weights `1,3,1,3,...`, sum mod 10 = 0; prefix is `978` or `979`. Verified against `9780306406157`, `9781861972712`.

For each algorithm, the test file also confirms that a single-digit bump of a known-valid value flips the validator red — so a check-digit bug in `src/index.ts` produces a value that the test's independent validator rejects.

## Wrap-vs-author choice — author from scratch

Per spec A4: this pack lives in the **left column** of the wrap-vs-author table. Every kind we ship is a validated/check-summed identifier where a wrong algorithm is a **silent** failure — a credit-card PAN with a bad Luhn digit passes the regex, looks plausible, then gets rejected by the payment processor downstream. An IBAN with a bad mod-97 remainder passes the form and blocks the run. SWIFT/BIC and ISBN-13 are pure-format strings whose wrongness is silent until the consumer rejects them.

Wrapping a generic library (faker's `finance.iban`, `card-validator`, etc.) would import a wider surface for marginal gain on the moat itself: the value here IS getting Luhn, mod-97, ABA-weighted, and ISBN-13 check digits exactly right. So:

- **Zero runtime deps beyond `@qa-expert/fixture-pack-contract` + `zod`.**
- PRNG implemented in-file (sfc32 + FNV-1a seed hash) — no `Math.random()`.
- IBAN mod-97 uses BigInt natively — no big-integer library needed (a 30-digit IBAN integer fits well within JS BigInt).
- All algorithm tables (brand prefixes, country lengths, ABA weights) live in source comments + the test file so the rule and its oracle are both auditable.

## Locale

This pack is intentionally **locale-agnostic** — credit-card / IBAN / SWIFT / ABA / ISBN are international or US-only protocol-level identifiers, not localized strings. `fixture-pack.json` declares `"locales": []`. The IBAN `country` param is a country-of-issue selector, not a locale: `iban?country=DE` and `iban?country=FR` differ in *algorithm*, not language.

## Testing

```bash
bun install
bun x tsc --noEmit
bun test
```

All three must be green. The suite is self-contained — no fixtures on disk, no host wiring required.

## License

MIT — see [`LICENSE`](./LICENSE). Copyright 2026 Ricardo Gusmão.
