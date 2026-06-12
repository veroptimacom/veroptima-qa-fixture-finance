/**
 * veroptima-qa-fixture-finance — finance / international identifiers fixture pack
 * for qa-expert plugins.
 *
 * Implements `@qa-expert/fixture-pack-contract` v0.1.0.
 *
 * Ships five kinds, all locale-agnostic, all seed-deterministic, all dependency-free:
 *
 *   - `credit-card`     -> brand-prefixed PAN with Luhn check digit
 *                          (visa | mastercard | amex | discover | any)
 *   - `iban`            -> country-formatted IBAN with mod-97 check digits
 *                          (DE/GB/FR/ES/IT/NL/BE/PT/CH/BR; unsupported throws)
 *   - `swift-bic`       -> 8- or 11-char SWIFT/BIC (4 bank + 2 country + 2 location + opt 3 branch)
 *   - `routing-number`  -> 9-digit US ABA routing number with mod-10 weighted check
 *   - `isbn-13`         -> ISBN-13 with mod-10 alternating-weight check digit
 *
 * Each kind accepts an optional `validity` param (default `"valid"`) that asks
 * for KNOWN-INVALID variants for negative-path tests. Modes:
 *
 *   - `valid`              -> default; passes every documented check.
 *   - `invalid-checksum`   -> right shape, wrong check digit. (swift-bic throws — no checksum exists.)
 *   - `invalid-length`     -> wrong character count.
 *   - `invalid-format`     -> wrong alphabet (letter where digit expected).
 *   - `invalid-prefix`     -> credit-card (brand-length kept, prefix wrong) | isbn-13 (uses "977", ISSN region).
 *   - `invalid-country`    -> iban only; two-letter CC with no shipped entry ("XX").
 *
 * An unsupported (kind, mode) pair throws `unsupported-validity-mode: <mode>`
 * — never silently falls back to `valid`. The per-kind matrix lives in the README.
 *
 * Determinism: same (seed, validity, params, locale) -> byte-identical output.
 * PRNG is sfc32 seeded by FNV-1a over a canonicalized
 * `{seed, kind, locale, sortedParams}` key. Invalidation consumes a few extra
 * RNG draws AFTER the valid value is built, so the seed determines both the
 * valid scaffold AND the corruption position. No `Math.random()`, no
 * `Date.now()`, no `crypto.randomUUID()`.
 *
 * Correctness IS the moat (spec A4 left column): every kind has a check-digit
 * algorithm where wrongness is silent. The test file reimplements each
 * algorithm independently as the oracle so a regression in this file flips
 * the suite red.
 */
import {
  defineFixturePack,
  FixturePackManifestSchema,
  type FixturePack,
  type Generator,
  type GenContext,
  type GenResult,
  type PluginContext,
  type QaPluginFactory,
} from "@qa-expert/fixture-pack-contract";
import { z } from "zod";
import manifestJson from "../fixture-pack.json" with { type: "json" };

/**
 * Parse the on-disk manifest through the schema at module load. This narrows
 * `family` from `string` to the literal `"fixture-pack"` and validates the
 * shape at boot.
 */
const manifest = FixturePackManifestSchema.parse(manifestJson);

// -- Seedable PRNG (sfc32) + FNV-1a seed hash --------------------------------
// Identical algorithm to veroptima-qa-fixture-br-gov; reimplemented in-file so
// this pack stays dependency-free.

/** FNV-1a 32-bit over a UTF-8 string. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** sfc32 PRNG seeded by FNV-1a expansion of one integer. */
function makeRng(seedInt: number): () => number {
  let a = fnv1a32(`${seedInt}/0`);
  let b = fnv1a32(`${seedInt}/1`);
  let c = fnv1a32(`${seedInt}/2`);
  let d = fnv1a32(`${seedInt}/3`);
  for (let i = 0; i < 12; i++) {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) | 0;
  }
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function deriveSeedInt(
  kind: string,
  params: unknown,
  ctx: GenContext,
): number {
  const key = JSON.stringify({
    seed: ctx.seed,
    kind,
    locale: ctx.locale ?? "",
    params: canonicalize(stripDefaultValidity(params)),
  });
  return fnv1a32(key);
}

/**
 * Strip `validity: "valid"` from the seed-derivation key so the default mode
 * stays byte-identical to the pre-validity-feature behaviour. Any other mode
 * IS part of the key, which gives the post-processor distinct seeds (and
 * therefore distinct values) per mode.
 *
 * This is the ONLY place where validity gets erased; the post-processor still
 * sees the full params object and runs the right invalidation.
 */
function stripDefaultValidity(params: unknown): unknown {
  if (params === null || typeof params !== "object") return params;
  if (Array.isArray(params)) return params;
  const obj = params as Record<string, unknown>;
  if (obj.validity !== "valid") return obj;
  const { validity: _drop, ...rest } = obj;
  void _drop;
  return rest;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = canonicalize(obj[k]);
  }
  return out;
}

// -- Draw helpers ------------------------------------------------------------

function randInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function randDigit(rng: () => number): number {
  return randInt(rng, 10);
}

function randDigits(rng: () => number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(randDigit(rng));
  return out;
}

function pick<T>(rng: () => number, arr: ReadonlyArray<T>): T {
  return arr[randInt(rng, arr.length)] as T;
}

function randUpperLetter(rng: () => number): string {
  return String.fromCharCode(65 + randInt(rng, 26));
}

function randUpperLetters(rng: () => number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += randUpperLetter(rng);
  return out;
}

// -- Validity modes ----------------------------------------------------------
//
// Shared vocabulary across every kind. Each per-kind validity post-processor
// is responsible for deciding which subset of these it supports; an
// unsupported (kind, mode) pair throws `unsupported-validity-mode: <mode>`.
//
// The default mode is `"valid"`, which MUST be a byte-identical no-op vs the
// pre-validity-feature behaviour for any unchanged caller.

const VALIDITY_MODES = [
  "valid",
  "invalid-checksum",
  "invalid-length",
  "invalid-format",
  "invalid-prefix",
  "invalid-country",
] as const;
type ValidityMode = (typeof VALIDITY_MODES)[number];

const ValidityModeSchema = z.enum(VALIDITY_MODES).default("valid");

function unsupportedValidity(mode: ValidityMode): never {
  throw new Error(`qa-fixture-finance: unsupported-validity-mode: ${mode}`);
}

/** Bump a single decimal digit so it differs from the original. */
function bumpDigit(d: number): number {
  return (d + 1) % 10;
}

/**
 * Pick a deterministic index in [0, max). Consumes one rng draw, so the
 * (seed, mode, params, locale) tuple still uniquely determines the output.
 */
function pickIndex(rng: () => number, max: number): number {
  if (max <= 0) throw new Error("qa-fixture-finance: pickIndex max must be > 0");
  return randInt(rng, max);
}

/** Insert a deterministic upper-case letter at `pos` in a numeric string. */
function injectLetter(s: string, pos: number, letter: string): string {
  if (pos < 0 || pos >= s.length) {
    throw new Error(
      `qa-fixture-finance: injectLetter -- position ${pos} out of bounds [0, ${s.length})`,
    );
  }
  return s.slice(0, pos) + letter + s.slice(pos + 1);
}

// -- Credit card (Luhn) ------------------------------------------------------

/**
 * Luhn check digit for a numeric base (the check digit is appended at the
 * rightmost position). Walk base right-to-left, double every other digit
 * starting from the rightmost base position (because the check digit will
 * sit at position-from-the-right 1, not doubled); sum of digit-sums + check
 * must satisfy mod 10 = 0.
 */
function luhnCheckDigit(base: number[]): number {
  let sum = 0;
  let doubleIt = true;
  for (let i = base.length - 1; i >= 0; i--) {
    let d = base[i] as number;
    if (doubleIt) {
      d = d * 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleIt = !doubleIt;
  }
  return (10 - (sum % 10)) % 10;
}

type CreditCardBrand = "visa" | "mastercard" | "amex" | "discover" | "any";

/**
 * Brand-specific BIN prefix tables + allowed total lengths.
 *
 *   Visa       prefix 4               length 13 | 16 | 19
 *   MasterCard prefix 51..55 or 2221..2720  length 16
 *   Amex       prefix 34 or 37        length 15
 *   Discover   prefix 6011 | 65 | 644..649 | 622126..622925  length 16..19
 */
interface BrandSpec {
  prefix(rng: () => number): string;
  lengths: ReadonlyArray<number>;
}

const BRAND_SPECS: Record<Exclude<CreditCardBrand, "any">, BrandSpec> = {
  visa: {
    prefix: () => "4",
    lengths: [13, 16, 19],
  },
  mastercard: {
    prefix: (rng) => {
      if (randInt(rng, 2) === 0) {
        return String(51 + randInt(rng, 5)); // 51..55
      }
      return String(2221 + randInt(rng, 2720 - 2221 + 1)); // 2221..2720
    },
    lengths: [16],
  },
  amex: {
    prefix: (rng) => (randInt(rng, 2) === 0 ? "34" : "37"),
    lengths: [15],
  },
  discover: {
    prefix: (rng) => {
      const which = randInt(rng, 4);
      if (which === 0) return "6011";
      if (which === 1) return "65";
      if (which === 2) return String(644 + randInt(rng, 6)); // 644..649
      return String(622126 + randInt(rng, 622925 - 622126 + 1)); // 622126..622925
    },
    lengths: [16, 17, 18, 19],
  },
};

const CARD_BRANDS: ReadonlyArray<Exclude<CreditCardBrand, "any">> = [
  "visa",
  "mastercard",
  "amex",
  "discover",
];

const CreditCardParamsSchema = z
  .object({
    brand: z
      .enum(["visa", "mastercard", "amex", "discover", "any"])
      .default("any"),
    validity: ValidityModeSchema,
  })
  .strict()
  .default({ brand: "any", validity: "valid" });
type CreditCardParams = z.output<typeof CreditCardParamsSchema>;
type CreditCardParamsInput = z.input<typeof CreditCardParamsSchema>;

function generateCreditCard(
  rng: () => number,
  params: CreditCardParams,
): string {
  const brand: Exclude<CreditCardBrand, "any"> =
    params.brand === "any" ? pick(rng, CARD_BRANDS) : params.brand;
  const spec = BRAND_SPECS[brand];
  const prefix = spec.prefix(rng);
  const totalLength = pick(rng, spec.lengths);
  const baseLength = totalLength - 1;
  if (prefix.length > baseLength) {
    throw new Error(
      `qa-fixture-finance: credit-card -- prefix "${prefix}" longer than allowed base ${baseLength} for brand "${brand}"`,
    );
  }
  const base: number[] = prefix.split("").map((c) => Number(c));
  while (base.length < baseLength) base.push(randDigit(rng));
  const check = luhnCheckDigit(base);
  const valid = [...base, check].join("");
  return applyCreditCardValidity(rng, valid, params, brand, totalLength);
}

/**
 * Post-process a Luhn-valid PAN into the requested invalid variant. Determinism
 * is preserved by drawing further from the SAME rng that built `valid` — so
 * (seed, validity, params) -> unique output.
 */
function applyCreditCardValidity(
  rng: () => number,
  valid: string,
  params: CreditCardParams,
  brand: Exclude<CreditCardBrand, "any">,
  totalLength: number,
): string {
  const mode = params.validity;
  if (mode === "valid") return valid;

  if (mode === "invalid-checksum") {
    // Replace last digit with (check + 1) % 10. Length + alphabet preserved;
    // Luhn fails.
    const last = Number(valid[valid.length - 1]);
    const wrong = bumpDigit(last);
    return valid.slice(0, -1) + String(wrong);
  }

  if (mode === "invalid-length") {
    // Drop the last digit. Length is now off by one; alphabet kept.
    return valid.slice(0, -1);
  }

  if (mode === "invalid-format") {
    // Insert an upper-case letter at a seed-derived digit position. We avoid
    // overwriting the prefix's first char because most brand-prefix detectors
    // also look at the first 1-2 digits and we want this to STILL look
    // brand-shaped, just non-numeric somewhere in the middle.
    const pos = pickIndex(rng, valid.length - 1) + 1; // [1, len-1]
    const letter = randUpperLetter(rng);
    return injectLetter(valid, pos, letter);
  }

  if (mode === "invalid-prefix") {
    // Produce a Luhn-valid number whose prefix doesn't match the requested
    // brand. Length still matches the requested brand. Spec example:
    // brand=amex, prefix="12", length=15.
    const wrongPrefix = "12";
    const baseLength = totalLength - 1;
    const base: number[] = wrongPrefix.split("").map((c) => Number(c));
    while (base.length < baseLength) base.push(randDigit(rng));
    const check = luhnCheckDigit(base);
    void brand; // brand drives length only — wrong prefix is intentional
    return [...base, check].join("");
  }

  if (mode === "invalid-country") return unsupportedValidity(mode);

  // Should never reach here — the schema enum already constrained `mode`.
  return unsupportedValidity(mode);
}

// -- IBAN (mod-97) -----------------------------------------------------------

/**
 * IBAN structure: 2-letter country + 2 check digits + country-specific BBAN.
 * Validation algorithm (ISO 13616): move the first 4 chars to the end, convert
 * letters to digits (A=10, B=11, ..., Z=35), interpret as one integer,
 * mod 97 must equal 1.
 *
 * BBAN per country (n=digit, a=upper alpha, c=alphanumeric):
 *
 *   DE 22:  8n bank   + 10n account                              ("18n")
 *   GB 22:  4a bank   + 6n sort   + 8n account                   ("4a 14n")
 *   FR 27:  5n bank   + 5n branch + 11c account + 2n RIB         ("10n 11c 2n")
 *   ES 24:  4n bank   + 4n branch + 2n check    + 10n account    ("20n")
 *   IT 27:  1a CIN    + 5n bank   + 5n branch   + 12c account    ("1a 10n 12c")
 *   NL 18:  4a bank   + 10n account                              ("4a 10n")
 *   BE 16:  3n bank   + 7n account + 2n nat-check                ("12n")
 *   PT 25:  4n bank   + 4n branch + 11n account + 2n check       ("21n")
 *   CH 21:  5n bank   + 12c account                              ("5n 12c")
 *   BR 29:  8n bank   + 5n branch + 10n account + 1a type + 1c   (per IBAN registry)
 */
interface IbanCountrySpec {
  totalLength: number;
  bban(rng: () => number): string;
}

function bbanDigits(rng: () => number, n: number): string {
  return randDigits(rng, n).join("");
}

function bbanLetters(rng: () => number, n: number): string {
  return randUpperLetters(rng, n);
}

function bbanAlphanumeric(rng: () => number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    if (randInt(rng, 2) === 0) {
      s += String(randDigit(rng));
    } else {
      s += randUpperLetter(rng);
    }
  }
  return s;
}

const IBAN_COUNTRIES: Record<string, IbanCountrySpec> = {
  DE: {
    totalLength: 22,
    bban: (rng) => bbanDigits(rng, 8) + bbanDigits(rng, 10),
  },
  GB: {
    totalLength: 22,
    bban: (rng) => bbanLetters(rng, 4) + bbanDigits(rng, 6) + bbanDigits(rng, 8),
  },
  FR: {
    totalLength: 27,
    bban: (rng) =>
      bbanDigits(rng, 5) +
      bbanDigits(rng, 5) +
      bbanAlphanumeric(rng, 11) +
      bbanDigits(rng, 2),
  },
  ES: {
    totalLength: 24,
    bban: (rng) =>
      bbanDigits(rng, 4) +
      bbanDigits(rng, 4) +
      bbanDigits(rng, 2) +
      bbanDigits(rng, 10),
  },
  IT: {
    totalLength: 27,
    bban: (rng) =>
      bbanLetters(rng, 1) +
      bbanDigits(rng, 5) +
      bbanDigits(rng, 5) +
      bbanAlphanumeric(rng, 12),
  },
  NL: {
    totalLength: 18,
    bban: (rng) => bbanLetters(rng, 4) + bbanDigits(rng, 10),
  },
  BE: {
    totalLength: 16,
    bban: (rng) =>
      bbanDigits(rng, 3) + bbanDigits(rng, 7) + bbanDigits(rng, 2),
  },
  PT: {
    totalLength: 25,
    bban: (rng) =>
      bbanDigits(rng, 4) +
      bbanDigits(rng, 4) +
      bbanDigits(rng, 11) +
      bbanDigits(rng, 2),
  },
  CH: {
    totalLength: 21,
    bban: (rng) => bbanDigits(rng, 5) + bbanAlphanumeric(rng, 12),
  },
  BR: {
    totalLength: 29,
    bban: (rng) =>
      bbanDigits(rng, 8) +
      bbanDigits(rng, 5) +
      bbanDigits(rng, 10) +
      bbanLetters(rng, 1) +
      bbanAlphanumeric(rng, 1),
  },
};

/**
 * Convert an IBAN-like string to the integer used by mod-97.
 *   1. Move first 4 chars to end.
 *   2. Replace letters with two-digit numbers: A=10, B=11, ..., Z=35.
 * Returns a BigInt for the mod-97 calculation.
 */
function ibanToInteger(s: string): bigint {
  const rearranged = s.slice(4) + s.slice(0, 4);
  let digits = "";
  for (const ch of rearranged) {
    if (ch >= "0" && ch <= "9") {
      digits += ch;
    } else if (ch >= "A" && ch <= "Z") {
      digits += String(ch.charCodeAt(0) - 55); // A=65 -> 10
    } else {
      throw new Error(
        `qa-fixture-finance: iban -- illegal character "${ch}" while computing mod-97`,
      );
    }
  }
  return BigInt(digits);
}

function ibanCheckDigits(country: string, bban: string): string {
  const trial = country + "00" + bban;
  const n = ibanToInteger(trial);
  const check = 98n - (n % 97n);
  return check.toString().padStart(2, "0");
}

const IbanParamsSchema = z
  .object({
    country: z.string().length(2),
    validity: ValidityModeSchema,
  })
  .strict();
type IbanParams = z.output<typeof IbanParamsSchema>;
type IbanParamsInput = z.input<typeof IbanParamsSchema>;

function generateIban(rng: () => number, params: IbanParams): string {
  const requestedCc = params.country.toUpperCase();
  const mode = params.validity;

  // invalid-country is handled SEPARATELY: it bypasses the per-country BBAN
  // spec because the whole point is the country code is unsupported.
  if (mode === "invalid-country") {
    return generateInvalidCountryIban(rng);
  }

  const spec = IBAN_COUNTRIES[requestedCc];
  if (!spec) {
    throw new Error(`qa-fixture-finance: unsupported-country: ${requestedCc}`);
  }
  const bban = spec.bban(rng);
  const expectedBbanLen = spec.totalLength - 4;
  if (bban.length !== expectedBbanLen) {
    throw new Error(
      `qa-fixture-finance: iban -- internal BBAN length mismatch for ${requestedCc} (got ${bban.length}, want ${expectedBbanLen})`,
    );
  }
  const check = ibanCheckDigits(requestedCc, bban);
  const valid = requestedCc + check + bban;
  if (valid.length !== spec.totalLength) {
    throw new Error(
      `qa-fixture-finance: iban -- assembled length ${valid.length} != expected ${spec.totalLength} for ${requestedCc}`,
    );
  }
  return applyIbanValidity(rng, valid, mode);
}

function applyIbanValidity(
  rng: () => number,
  valid: string,
  mode: ValidityMode,
): string {
  if (mode === "valid") return valid;

  if (mode === "invalid-checksum") {
    // Flip the second IBAN check digit (position 3) by +1 mod 10 so mod-97 ≠ 1.
    // Positions 2-3 are ALWAYS digits by IBAN construction, so we don't risk
    // landing on a letter.
    const flipped = bumpDigit(Number(valid[3]));
    return valid.slice(0, 3) + String(flipped) + valid.slice(4);
  }

  if (mode === "invalid-length") {
    // Drop the last BBAN char. Country prefix + check digits stay; length wrong.
    return valid.slice(0, -1);
  }

  if (mode === "invalid-format") {
    // Replace the second check digit with a letter. The IBAN regex
    // `[A-Z]{2}\d{2}...` rejects this; the mod-97 alphabet still accepts
    // letters elsewhere but the format rule says positions 2-3 must be digits.
    const letter = randUpperLetter(rng);
    return valid.slice(0, 3) + letter + valid.slice(4);
  }

  if (mode === "invalid-prefix") return unsupportedValidity(mode);

  // invalid-country handled above; any leftover mode is unsupported.
  return unsupportedValidity(mode);
}

/**
 * Produce a length-22 IBAN with country code "XX" (no shipped entry) and
 * mod-97-valid check digits, so the failure isolates to the country lookup,
 * not the checksum or the length.
 */
function generateInvalidCountryIban(rng: () => number): string {
  const cc = "XX";
  const bban = bbanDigits(rng, 18); // 22 - 2 cc - 2 check = 18 BBAN chars
  const check = ibanCheckDigits(cc, bban);
  return cc + check + bban;
}

// -- SWIFT / BIC -------------------------------------------------------------

/**
 * SWIFT/BIC structure: 4 letters bank + 2 letters country + 2 alphanumeric
 * location + optional 3 alphanumeric branch (total length 8 or 11). No check
 * digit; correctness is purely format.
 */
const SwiftBicParamsSchema = z
  .object({
    length: z.union([z.literal(8), z.literal(11)]).default(8),
    validity: ValidityModeSchema,
  })
  .strict()
  .default({ length: 8, validity: "valid" });
type SwiftBicParams = z.output<typeof SwiftBicParamsSchema>;
type SwiftBicParamsInput = z.input<typeof SwiftBicParamsSchema>;

function randAlphanumericUpper(rng: () => number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    if (randInt(rng, 2) === 0) {
      s += String(randDigit(rng));
    } else {
      s += randUpperLetter(rng);
    }
  }
  return s;
}

function generateSwiftBic(rng: () => number, params: SwiftBicParams): string {
  const bank = randUpperLetters(rng, 4);
  const country = randUpperLetters(rng, 2);
  const location = randAlphanumericUpper(rng, 2);
  let valid: string;
  if (params.length === 8) {
    valid = bank + country + location;
  } else {
    const branch = randAlphanumericUpper(rng, 3);
    valid = bank + country + location + branch;
  }
  return applySwiftBicValidity(rng, valid, params);
}

function applySwiftBicValidity(
  rng: () => number,
  valid: string,
  params: SwiftBicParams,
): string {
  const mode = params.validity;
  if (mode === "valid") return valid;

  if (mode === "invalid-checksum") return unsupportedValidity(mode);

  if (mode === "invalid-length") {
    // Drop the last char; length 7 (or 10) is now off-spec.
    return valid.slice(0, -1);
  }

  if (mode === "invalid-format") {
    // Replace a char in the BANK position (0..3, must be letters) with a digit.
    // The shape regex `^[A-Z]{4}[A-Z]{2}...` rejects this immediately.
    const pos = pickIndex(rng, 4);
    const digit = String(randDigit(rng));
    return valid.slice(0, pos) + digit + valid.slice(pos + 1);
  }

  // invalid-prefix, invalid-country: not applicable to swift-bic.
  return unsupportedValidity(mode);
}

// -- US ABA routing number ---------------------------------------------------

/**
 * 9-digit US routing number. Weights [3,7,1,3,7,1,3,7,1] left-to-right; the
 * SUM (including the last digit, which is the check) satisfies mod 10 = 0.
 *
 * The last weight is 1, so we pick the first 8 digits and compute the check.
 */
const ABA_WEIGHTS = [3, 7, 1, 3, 7, 1, 3, 7, 1] as const;

function abaCheckDigit(first8: number[]): number {
  let partial = 0;
  for (let i = 0; i < 8; i++) {
    partial += (first8[i] as number) * (ABA_WEIGHTS[i] as number);
  }
  return (10 - (partial % 10)) % 10;
}

const RoutingNumberParamsSchema = z
  .object({
    validity: ValidityModeSchema,
  })
  .strict()
  .default({ validity: "valid" });
type RoutingNumberParams = z.output<typeof RoutingNumberParamsSchema>;
type RoutingNumberParamsInput = z.input<typeof RoutingNumberParamsSchema>;

function generateRouting(
  rng: () => number,
  params: RoutingNumberParams,
): string {
  // Avoid leading 0 to keep the number visually plausible.
  const first = randInt(rng, 9) + 1;
  const rest = randDigits(rng, 7);
  const first8 = [first, ...rest];
  const check = abaCheckDigit(first8);
  const valid = [...first8, check].join("");
  return applyRoutingValidity(rng, valid, params);
}

function applyRoutingValidity(
  rng: () => number,
  valid: string,
  params: RoutingNumberParams,
): string {
  const mode = params.validity;
  if (mode === "valid") return valid;

  if (mode === "invalid-checksum") {
    // Flip a digit at a deterministic position so the weighted sum mod 10 ≠ 0.
    // We pick position 4 (mid-string) and bump it; for any single-digit bump
    // the weighted sum changes by w*delta where w is one of {3,7,1} and delta
    // in {1..9}, so the result CANNOT remain ≡ 0 (mod 10) without bumping by
    // a multiple of 10/gcd(w,10) -- all of 3, 7, 1 are coprime with 10, so
    // any +1 bump changes the residue.
    const pos = 4;
    const flipped = bumpDigit(Number(valid[pos]));
    return valid.slice(0, pos) + String(flipped) + valid.slice(pos + 1);
  }

  if (mode === "invalid-length") {
    // Drop the last digit; length 8 ≠ required 9.
    return valid.slice(0, -1);
  }

  if (mode === "invalid-format") {
    // Insert a letter at a seed-derived position.
    const pos = pickIndex(rng, valid.length);
    const letter = randUpperLetter(rng);
    return injectLetter(valid, pos, letter);
  }

  // invalid-prefix, invalid-country: not applicable to routing-number.
  return unsupportedValidity(mode);
}

// -- ISBN-13 -----------------------------------------------------------------

/**
 * ISBN-13: 13 digits. Weights alternate 1/3 over the first 12; the check
 * digit (position 13) makes the total mod 10 = 0. Prefix is "978" or "979".
 */
function isbn13CheckDigit(first12: number[]): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const w = i % 2 === 0 ? 1 : 3;
    sum += (first12[i] as number) * w;
  }
  return (10 - (sum % 10)) % 10;
}

const Isbn13ParamsSchema = z
  .object({
    validity: ValidityModeSchema,
  })
  .strict()
  .default({ validity: "valid" });
type Isbn13Params = z.output<typeof Isbn13ParamsSchema>;
type Isbn13ParamsInput = z.input<typeof Isbn13ParamsSchema>;

function generateIsbn13(rng: () => number, params: Isbn13Params): string {
  const prefix = randInt(rng, 2) === 0 ? [9, 7, 8] : [9, 7, 9];
  const rest = randDigits(rng, 9);
  const first12 = [...prefix, ...rest];
  const check = isbn13CheckDigit(first12);
  const valid = [...first12, check].join("");
  return applyIsbn13Validity(rng, valid, params);
}

function applyIsbn13Validity(
  rng: () => number,
  valid: string,
  params: Isbn13Params,
): string {
  const mode = params.validity;
  if (mode === "valid") return valid;

  if (mode === "invalid-checksum") {
    // Replace last digit with (check + 1) % 10. The alternating-weight sum mod
    // 10 ≠ 0.
    const last = Number(valid[valid.length - 1]);
    const wrong = bumpDigit(last);
    return valid.slice(0, -1) + String(wrong);
  }

  if (mode === "invalid-length") {
    // Drop the last digit. Length 12; prefix preserved.
    return valid.slice(0, -1);
  }

  if (mode === "invalid-format") {
    // Insert a letter at a seed-derived position past the "978/979" prefix so
    // the prefix-rule check is still well-formed enough to read.
    const pos = pickIndex(rng, valid.length - 3) + 3; // [3, len-1]
    const letter = randUpperLetter(rng);
    return injectLetter(valid, pos, letter);
  }

  if (mode === "invalid-prefix") {
    // Prefix "977" (ISSN region). Recompute mod-10 so the check digit is
    // locally correct EXCEPT the prefix is wrong for an ISBN-13 validator.
    const rest = randDigits(rng, 9);
    const first12 = [9, 7, 7, ...rest];
    const check = isbn13CheckDigit(first12);
    return [...first12, check].join("");
  }

  // invalid-country: not applicable to isbn-13.
  return unsupportedValidity(mode);
}

// -- Generator definitions ---------------------------------------------------

const creditCardGenerator: Generator<CreditCardParamsInput, string> = {
  kind: "credit-card",
  outputs: "string",
  paramsSchema: CreditCardParamsSchema as unknown as z.ZodType<CreditCardParamsInput>,
  generate(params, ctx) {
    const parsed = CreditCardParamsSchema.parse(params ?? {});
    const seedInt = deriveSeedInt("credit-card", parsed, ctx);
    const rng = makeRng(seedInt);
    return generateCreditCard(rng, parsed);
  },
};

const ibanGenerator: Generator<IbanParamsInput, string> = {
  kind: "iban",
  outputs: "string",
  paramsSchema: IbanParamsSchema as unknown as z.ZodType<IbanParamsInput>,
  generate(params, ctx) {
    const parsed = IbanParamsSchema.parse(params ?? {});
    const seedInt = deriveSeedInt("iban", parsed, ctx);
    const rng = makeRng(seedInt);
    return generateIban(rng, parsed);
  },
};

const swiftBicGenerator: Generator<SwiftBicParamsInput, string> = {
  kind: "swift-bic",
  outputs: "string",
  paramsSchema: SwiftBicParamsSchema as unknown as z.ZodType<SwiftBicParamsInput>,
  generate(params, ctx) {
    const parsed = SwiftBicParamsSchema.parse(params ?? {});
    const seedInt = deriveSeedInt("swift-bic", parsed, ctx);
    const rng = makeRng(seedInt);
    return generateSwiftBic(rng, parsed);
  },
};

const routingGenerator: Generator<RoutingNumberParamsInput | void, string> = {
  kind: "routing-number",
  outputs: "string",
  paramsSchema: RoutingNumberParamsSchema as unknown as z.ZodType<
    RoutingNumberParamsInput | void
  >,
  generate(params, ctx) {
    const parsed = RoutingNumberParamsSchema.parse(params ?? {});
    const seedInt = deriveSeedInt("routing-number", parsed, ctx);
    const rng = makeRng(seedInt);
    return generateRouting(rng, parsed);
  },
};

const isbn13Generator: Generator<Isbn13ParamsInput | void, string> = {
  kind: "isbn-13",
  outputs: "string",
  paramsSchema: Isbn13ParamsSchema as unknown as z.ZodType<
    Isbn13ParamsInput | void
  >,
  generate(params, ctx) {
    const parsed = Isbn13ParamsSchema.parse(params ?? {});
    const seedInt = deriveSeedInt("isbn-13", parsed, ctx);
    const rng = makeRng(seedInt);
    return generateIsbn13(rng, parsed);
  },
};

// -- Pack assembly -----------------------------------------------------------

const allGenerators: Array<Generator<unknown, GenResult>> = [
  creditCardGenerator as unknown as Generator<unknown, GenResult>,
  ibanGenerator as unknown as Generator<unknown, GenResult>,
  swiftBicGenerator as unknown as Generator<unknown, GenResult>,
  routingGenerator as unknown as Generator<unknown, GenResult>,
  isbn13Generator as unknown as Generator<unknown, GenResult>,
];

const pack: FixturePack = defineFixturePack({
  manifest,
  generators: allGenerators as unknown as Generator[],
});

// -- Factory -----------------------------------------------------------------

export const FinanceFixtureConfigSchema = z.object({}).strict();
export type FinanceFixtureConfig = z.infer<typeof FinanceFixtureConfigSchema>;

const factory: QaPluginFactory<FinanceFixtureConfig, FixturePack> = {
  family: "fixture-pack",
  subkind: "finance",
  contractVersion: "0.1.0",
  configSchema: FinanceFixtureConfigSchema,
  create(_config: FinanceFixtureConfig, _ctx: PluginContext): FixturePack {
    return pack;
  },
};

export default factory;

// -- Internals re-exported for the test suite --------------------------------

export {
  pack,
  luhnCheckDigit,
  ibanToInteger,
  ibanCheckDigits,
  abaCheckDigit,
  isbn13CheckDigit,
  IBAN_COUNTRIES,
  VALIDITY_MODES,
  creditCardGenerator,
  ibanGenerator,
  swiftBicGenerator,
  routingGenerator,
  isbn13Generator,
};
export type { ValidityMode };
