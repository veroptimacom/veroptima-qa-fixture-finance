/**
 * Tests for veroptima-qa-fixture-finance.
 *
 * Strategy: every kind gets a cross-call replay test (determinism) PLUS an
 * independent check-digit validator INSIDE the test file. A regression in
 * `src/index.ts` that miscomputes a Luhn/IBAN/ABA/ISBN-13 check digit must
 * fail here, regardless of how the source rationalizes it -- the test owns
 * its own algorithm reimplementation as the oracle.
 */
import { describe, expect, test } from "bun:test";
import factory, {
  pack,
  VALIDITY_MODES,
  creditCardGenerator,
  ibanGenerator,
  swiftBicGenerator,
  routingGenerator,
  isbn13Generator,
} from "../index.js";
import type { ValidityMode } from "../index.js";
import type {
  GenContext,
  PluginContext,
} from "@qa-expert/fixture-pack-contract";

// -- Test fixtures -----------------------------------------------------------

function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function makeCtx(overrides: Partial<GenContext> = {}): GenContext {
  return {
    seed: "seed-1",
    locale: undefined,
    logger: noopLogger(),
    ...overrides,
  };
}

function makePluginCtx(): PluginContext {
  return {
    engineerId: "test",
    runTag: "test-run",
    secrets: {
      scheme: "env",
      async resolve() {
        return "";
      },
      describe() {
        return { scheme: "env", reference: "" };
      },
    },
    logger: noopLogger(),
    fetch: globalThis.fetch,
  };
}

// -- Independent validators (oracles) ----------------------------------------

/** Standard Luhn validator: sum all digits, doubling every second from the right (so the check digit's neighbour is doubled). */
function validateLuhn(num: string): boolean {
  if (!/^\d+$/.test(num)) return false;
  let sum = 0;
  let doubleIt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (doubleIt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleIt = !doubleIt;
  }
  return sum % 10 === 0;
}

/** Mod-97 IBAN validator (ISO 13616). */
function validateIban(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let digits = "";
  for (const ch of rearranged) {
    if (ch >= "0" && ch <= "9") digits += ch;
    else if (ch >= "A" && ch <= "Z") digits += String(ch.charCodeAt(0) - 55);
    else return false;
  }
  return BigInt(digits) % 97n === 1n;
}

/** ABA mod-10 weighted check (weights [3,7,1] repeated). */
function validateAba(num: string): boolean {
  if (!/^\d{9}$/.test(num)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(num[i]) * (weights[i] as number);
  }
  return sum % 10 === 0;
}

/** ISBN-13 alternating-weight (1/3) mod-10 check. */
function validateIsbn13(num: string): boolean {
  if (!/^\d{13}$/.test(num)) return false;
  if (!num.startsWith("978") && !num.startsWith("979")) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const w = i % 2 === 0 ? 1 : 3;
    sum += Number(num[i]) * w;
  }
  return sum % 10 === 0;
}

/** SWIFT/BIC format check (no check digit). */
function validateSwiftBic(s: string, expectedLength: 8 | 11): boolean {
  if (s.length !== expectedLength) return false;
  // First 4 = letters (bank), next 2 = letters (country), next 2 = alphanumeric (location),
  // optional 3 alphanumeric (branch).
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(s)) return false;
  return true;
}

// -- Pack-level / manifest sanity --------------------------------------------

describe("pack", () => {
  test("manifest declares the five required kinds", () => {
    const names = pack.manifest.kinds.map((k) => k.name).sort();
    expect(names).toEqual(
      ["credit-card", "iban", "isbn-13", "routing-number", "swift-bic"].sort(),
    );
  });

  test("manifest locales = [] (locale-agnostic)", () => {
    expect(pack.manifest.locales).toEqual([]);
  });

  test("manifest domain = finance", () => {
    expect(pack.manifest.domain).toBe("finance");
  });

  test("factory.create returns the pack", async () => {
    const result = await factory.create({}, makePluginCtx());
    expect(result.manifest.name).toBe("@qa-expert/qa-fixture-finance");
    expect(result.generators).toHaveLength(5);
  });

  test("every generator outputs string in this pack (no file kinds)", () => {
    for (const g of pack.generators) {
      expect(g.outputs).toBe("string");
    }
  });
});

// -- credit-card -------------------------------------------------------------

describe("credit-card", () => {
  test("determinism -- same seed/params -> same output", async () => {
    const a = await creditCardGenerator.generate({ brand: "any" }, makeCtx());
    const b = await creditCardGenerator.generate({ brand: "any" }, makeCtx());
    expect(a).toBe(b);
  });

  test("Luhn validator self-check on a known-valid + known-invalid PAN", () => {
    // 4111 1111 1111 1111 is the canonical Visa test PAN; Luhn-valid.
    expect(validateLuhn("4111111111111111")).toBe(true);
    // Same with one digit bumped -> invalid.
    expect(validateLuhn("4111111111111112")).toBe(false);
    // Amex test PAN 3782 822463 10005.
    expect(validateLuhn("378282246310005")).toBe(true);
  });

  test("default (any) -- valid Luhn + length matches a known brand", async () => {
    const out = await creditCardGenerator.generate(
      undefined as unknown as { brand: "any" },
      makeCtx(),
    );
    expect(/^\d+$/.test(out)).toBe(true);
    expect(validateLuhn(out)).toBe(true);
    // Length must be one of the known brand lengths (13/15/16/17/18/19).
    expect([13, 15, 16, 17, 18, 19]).toContain(out.length);
  });

  test("brand=visa -- starts with 4, length 13/16/19, Luhn-valid", async () => {
    for (let i = 0; i < 5; i++) {
      const out = await creditCardGenerator.generate(
        { brand: "visa" },
        makeCtx({ seed: `visa-${i}` }),
      );
      expect(out.startsWith("4")).toBe(true);
      expect([13, 16, 19]).toContain(out.length);
      expect(validateLuhn(out)).toBe(true);
    }
  });

  test("brand=mastercard -- prefix in 51-55 or 2221-2720, length 16, Luhn-valid", async () => {
    for (let i = 0; i < 5; i++) {
      const out = await creditCardGenerator.generate(
        { brand: "mastercard" },
        makeCtx({ seed: `mc-${i}` }),
      );
      expect(out.length).toBe(16);
      const two = Number(out.slice(0, 2));
      const four = Number(out.slice(0, 4));
      const inClassic = two >= 51 && two <= 55;
      const inNew = four >= 2221 && four <= 2720;
      expect(inClassic || inNew).toBe(true);
      expect(validateLuhn(out)).toBe(true);
    }
  });

  test("brand=amex -- starts with 34 or 37, length 15, Luhn-valid", async () => {
    for (let i = 0; i < 5; i++) {
      const out = await creditCardGenerator.generate(
        { brand: "amex" },
        makeCtx({ seed: `amex-${i}` }),
      );
      expect(out.length).toBe(15);
      expect(out.startsWith("34") || out.startsWith("37")).toBe(true);
      expect(validateLuhn(out)).toBe(true);
    }
  });

  test("brand=discover -- one of the documented prefix ranges, length 16-19, Luhn-valid", async () => {
    for (let i = 0; i < 8; i++) {
      const out = await creditCardGenerator.generate(
        { brand: "discover" },
        makeCtx({ seed: `disc-${i}` }),
      );
      expect(out.length).toBeGreaterThanOrEqual(16);
      expect(out.length).toBeLessThanOrEqual(19);
      const six = Number(out.slice(0, 6));
      const three = Number(out.slice(0, 3));
      const two = Number(out.slice(0, 2));
      const four = Number(out.slice(0, 4));
      const inRange =
        four === 6011 ||
        two === 65 ||
        (three >= 644 && three <= 649) ||
        (six >= 622126 && six <= 622925);
      expect(inRange).toBe(true);
      expect(validateLuhn(out)).toBe(true);
    }
  });

  test("changing seed changes the output", async () => {
    const a = await creditCardGenerator.generate(
      { brand: "visa" },
      makeCtx({ seed: "seed-1" }),
    );
    const b = await creditCardGenerator.generate(
      { brand: "visa" },
      makeCtx({ seed: "seed-2" }),
    );
    expect(a).not.toBe(b);
  });
});

// -- iban --------------------------------------------------------------------

describe("iban", () => {
  test("determinism -- same seed/params -> same output", async () => {
    const a = await ibanGenerator.generate({ country: "DE" }, makeCtx());
    const b = await ibanGenerator.generate({ country: "DE" }, makeCtx());
    expect(a).toBe(b);
  });

  test("validator self-check on canonical IBANs", () => {
    // Real published example IBANs (mod-97 valid):
    expect(validateIban("DE89370400440532013000")).toBe(true);
    expect(validateIban("GB82WEST12345698765432")).toBe(true);
    expect(validateIban("FR1420041010050500013M02606")).toBe(true);
    // Corrupted (bump one digit) -> invalid:
    expect(validateIban("DE89370400440532013001")).toBe(false);
  });

  test.each([
    ["DE", 22],
    ["GB", 22],
    ["FR", 27],
    ["ES", 24],
    ["IT", 27],
    ["NL", 18],
    ["BE", 16],
    ["PT", 25],
    ["CH", 21],
    ["BR", 29],
  ])(
    "country=%s -- length %i + mod-97 valid",
    async (country, expectedLength) => {
      const iban = await ibanGenerator.generate(
        { country },
        makeCtx({ seed: `iban-${country}` }),
      );
      expect(iban.length).toBe(expectedLength);
      expect(iban.startsWith(country)).toBe(true);
      expect(validateIban(iban)).toBe(true);
    },
  );

  test("country=de (lowercase) accepted and uppercased", async () => {
    const iban = await ibanGenerator.generate({ country: "de" }, makeCtx());
    expect(iban.startsWith("DE")).toBe(true);
    expect(validateIban(iban)).toBe(true);
  });

  test("unsupported country throws unsupported-country: <CC>", async () => {
    expect(() =>
      ibanGenerator.generate({ country: "XX" }, makeCtx()),
    ).toThrow(/unsupported-country: XX/);
    expect(() =>
      ibanGenerator.generate({ country: "JP" }, makeCtx()),
    ).toThrow(/unsupported-country: JP/);
  });
});

// -- swift-bic ---------------------------------------------------------------

describe("swift-bic", () => {
  test("determinism -- same seed/params -> same output", async () => {
    const a = await swiftBicGenerator.generate({ length: 8 }, makeCtx());
    const b = await swiftBicGenerator.generate({ length: 8 }, makeCtx());
    expect(a).toBe(b);
  });

  test("default length = 8 (well-formed)", async () => {
    const out = await swiftBicGenerator.generate(
      undefined as unknown as { length: 8 | 11 },
      makeCtx(),
    );
    expect(validateSwiftBic(out, 8)).toBe(true);
  });

  test("length=11 -- well-formed", async () => {
    const out = await swiftBicGenerator.generate({ length: 11 }, makeCtx());
    expect(validateSwiftBic(out, 11)).toBe(true);
  });

  test("changing seed changes the output", async () => {
    const a = await swiftBicGenerator.generate(
      { length: 8 },
      makeCtx({ seed: "swift-1" }),
    );
    const b = await swiftBicGenerator.generate(
      { length: 8 },
      makeCtx({ seed: "swift-2" }),
    );
    expect(a).not.toBe(b);
  });
});

// -- routing-number ----------------------------------------------------------

describe("routing-number", () => {
  test("determinism -- same seed -> same output", async () => {
    const a = await routingGenerator.generate(undefined, makeCtx());
    const b = await routingGenerator.generate(undefined, makeCtx());
    expect(a).toBe(b);
  });

  test("ABA validator self-check on canonical routing numbers", () => {
    // Wells Fargo CA: 121000248 (well-known + valid).
    expect(validateAba("121000248")).toBe(true);
    // Chase NY: 021000021.
    expect(validateAba("021000021")).toBe(true);
    // Same with last digit bumped -> invalid.
    expect(validateAba("121000249")).toBe(false);
    expect(validateAba("123456789")).toBe(false);
  });

  test("9 digits + ABA-valid across multiple seeds", async () => {
    for (let i = 0; i < 10; i++) {
      const out = await routingGenerator.generate(
        undefined,
        makeCtx({ seed: `aba-${i}` }),
      );
      expect(out).toMatch(/^\d{9}$/);
      expect(validateAba(out)).toBe(true);
    }
  });
});

// -- isbn-13 -----------------------------------------------------------------

describe("isbn-13", () => {
  test("determinism -- same seed -> same output", async () => {
    const a = await isbn13Generator.generate(undefined, makeCtx());
    const b = await isbn13Generator.generate(undefined, makeCtx());
    expect(a).toBe(b);
  });

  test("ISBN-13 validator self-check on canonical ISBNs", () => {
    // Real published ISBN-13s:
    expect(validateIsbn13("9780306406157")).toBe(true);
    expect(validateIsbn13("9781861972712")).toBe(true);
    // Same with last digit bumped -> invalid.
    expect(validateIsbn13("9780306406158")).toBe(false);
    // Wrong prefix.
    expect(validateIsbn13("1234567890128")).toBe(false);
  });

  test("13 digits + 978/979 prefix + ISBN-13 valid across multiple seeds", async () => {
    for (let i = 0; i < 10; i++) {
      const out = await isbn13Generator.generate(
        undefined,
        makeCtx({ seed: `isbn-${i}` }),
      );
      expect(out).toMatch(/^\d{13}$/);
      expect(out.startsWith("978") || out.startsWith("979")).toBe(true);
      expect(validateIsbn13(out)).toBe(true);
    }
  });
});

// -- Validity modes ----------------------------------------------------------
//
// For every kind: each SUPPORTED (kind, mode) pair gets determinism +
// validator round-trip + distinctness; each UNSUPPORTED pair must THROW
// `unsupported-validity-mode: <mode>` (no silent fallback).
//
// "Same validator the existing `valid` tests use" means: the composite
// validator each kind already exercises in its happy-path block — Luhn +
// length + prefix for credit-card, mod-97 + supported-country + expected-length
// for iban, ABA mod-10 weighted + `^\d{9}$` for routing, alternating-weight +
// `^\d{13}$` + `978/979` for isbn-13, format regex + expected-length for
// swift-bic. The composite is what survives all the way to a real validator's
// reject path.

// -- Composite per-kind validators -------------------------------------------

const CARD_LENGTHS: Record<
  Exclude<CreditCardBrand, "any">,
  ReadonlyArray<number>
> = {
  visa: [13, 16, 19],
  mastercard: [16],
  amex: [15],
  discover: [16, 17, 18, 19],
};

type CreditCardBrand = "visa" | "mastercard" | "amex" | "discover" | "any";

function cardPrefixMatchesBrand(
  s: string,
  brand: Exclude<CreditCardBrand, "any">,
): boolean {
  if (s.length < 2) return false;
  const two = Number(s.slice(0, 2));
  const three = Number(s.slice(0, 3));
  const four = s.length >= 4 ? Number(s.slice(0, 4)) : NaN;
  const six = s.length >= 6 ? Number(s.slice(0, 6)) : NaN;
  if (brand === "visa") return s.startsWith("4");
  if (brand === "mastercard") {
    return (two >= 51 && two <= 55) || (four >= 2221 && four <= 2720);
  }
  if (brand === "amex") return s.startsWith("34") || s.startsWith("37");
  // discover
  return (
    four === 6011 ||
    two === 65 ||
    (three >= 644 && three <= 649) ||
    (six >= 622126 && six <= 622925)
  );
}

/** Composite credit-card validator: digit-only + brand-length + brand-prefix + Luhn. */
function validateCreditCard(
  s: string,
  brand: Exclude<CreditCardBrand, "any">,
): boolean {
  if (!/^\d+$/.test(s)) return false;
  if (!CARD_LENGTHS[brand].includes(s.length)) return false;
  if (!cardPrefixMatchesBrand(s, brand)) return false;
  return validateLuhn(s);
}

const IBAN_LENGTHS: Record<string, number> = {
  DE: 22,
  GB: 22,
  FR: 27,
  ES: 24,
  IT: 27,
  NL: 18,
  BE: 16,
  PT: 25,
  CH: 21,
  BR: 29,
};

/** Composite IBAN validator: format + supported country + expected length + mod-97. */
function validateIbanStrict(s: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
  const cc = s.slice(0, 2);
  const expectedLen = IBAN_LENGTHS[cc];
  if (expectedLen === undefined) return false; // unsupported country
  if (s.length !== expectedLen) return false;
  return validateIban(s);
}

// Sanity-check the composites on the canonical fixtures used above so a
// regression in the validator itself is loud.
describe("composite validators -- self-check", () => {
  test("credit-card composite accepts canonical PANs per brand", () => {
    expect(validateCreditCard("4111111111111111", "visa")).toBe(true);
    expect(validateCreditCard("378282246310005", "amex")).toBe(true);
    // Wrong brand label -> rejected.
    expect(validateCreditCard("4111111111111111", "amex")).toBe(false);
    // Bumped check digit -> rejected.
    expect(validateCreditCard("4111111111111112", "visa")).toBe(false);
  });

  test("iban composite accepts canonical IBANs, rejects unsupported country", () => {
    expect(validateIbanStrict("DE89370400440532013000")).toBe(true);
    expect(validateIbanStrict("GB82WEST12345698765432")).toBe(true);
    // Bumped digit -> rejected.
    expect(validateIbanStrict("DE89370400440532013001")).toBe(false);
    // Unsupported country code (well-formed structure, but XX not in table).
    expect(validateIbanStrict("XX00000000000000000000")).toBe(false);
  });
});

// -- Support matrix (source of truth for the test sweep) ---------------------

interface KindMatrix {
  kind: string;
  supported: ReadonlyArray<ValidityMode>;
}

const SUPPORT_MATRIX: ReadonlyArray<KindMatrix> = [
  {
    kind: "credit-card",
    supported: [
      "valid",
      "invalid-checksum",
      "invalid-length",
      "invalid-format",
      "invalid-prefix",
    ],
  },
  {
    kind: "iban",
    supported: [
      "valid",
      "invalid-checksum",
      "invalid-length",
      "invalid-format",
      "invalid-country",
    ],
  },
  {
    kind: "swift-bic",
    supported: ["valid", "invalid-length", "invalid-format"],
  },
  {
    kind: "routing-number",
    supported: [
      "valid",
      "invalid-checksum",
      "invalid-length",
      "invalid-format",
    ],
  },
  {
    kind: "isbn-13",
    supported: [
      "valid",
      "invalid-checksum",
      "invalid-length",
      "invalid-format",
      "invalid-prefix",
    ],
  },
];

function isSupported(kind: string, mode: ValidityMode): boolean {
  const row = SUPPORT_MATRIX.find((r) => r.kind === kind);
  if (!row) throw new Error(`test bug: unknown kind ${kind}`);
  return row.supported.includes(mode);
}

// -- credit-card validity ----------------------------------------------------

describe("credit-card validity", () => {
  const BRAND: Exclude<CreditCardBrand, "any"> = "visa";

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "credit-card -- mode=%s -- determinism (same seed -> same output)",
    async (mode) => {
      if (!isSupported("credit-card", mode)) return; // covered by the throws-block
      const a = await creditCardGenerator.generate(
        { brand: BRAND, validity: mode },
        makeCtx({ seed: "cc-det" }),
      );
      const b = await creditCardGenerator.generate(
        { brand: BRAND, validity: mode },
        makeCtx({ seed: "cc-det" }),
      );
      expect(a).toBe(b);
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "credit-card -- mode=%s -- validator round-trip",
    async (mode) => {
      if (!isSupported("credit-card", mode)) return;
      const out = await creditCardGenerator.generate(
        { brand: BRAND, validity: mode },
        makeCtx({ seed: `cc-rt-${mode}` }),
      );
      if (mode === "valid") {
        expect(validateCreditCard(out, BRAND)).toBe(true);
      } else {
        expect(validateCreditCard(out, BRAND)).toBe(false);
      }
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "credit-card -- mode=%s -- distinct from valid (same seed)",
    async (mode) => {
      if (!isSupported("credit-card", mode) || mode === "valid") return;
      const seed = `cc-dist-${mode}`;
      const validOut = await creditCardGenerator.generate(
        { brand: BRAND, validity: "valid" },
        makeCtx({ seed }),
      );
      const invalidOut = await creditCardGenerator.generate(
        { brand: BRAND, validity: mode },
        makeCtx({ seed }),
      );
      expect(invalidOut).not.toBe(validOut);
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "credit-card -- unsupported mode=%s throws unsupported-validity-mode",
    async (mode) => {
      if (isSupported("credit-card", mode)) return;
      expect(() =>
        creditCardGenerator.generate(
          { brand: BRAND, validity: mode },
          makeCtx({ seed: "cc-throw" }),
        ),
      ).toThrow(new RegExp(`unsupported-validity-mode: ${mode}`));
    },
  );

  test("invalid-prefix preserves requested brand-length but breaks brand-prefix", async () => {
    for (const brand of ["visa", "mastercard", "amex", "discover"] as const) {
      const out = await creditCardGenerator.generate(
        { brand, validity: "invalid-prefix" },
        makeCtx({ seed: `cc-ip-${brand}` }),
      );
      // Length still matches the requested brand.
      expect(CARD_LENGTHS[brand]).toContain(out.length);
      // Prefix does NOT match the requested brand.
      expect(cardPrefixMatchesBrand(out, brand)).toBe(false);
      // But it's STILL Luhn-valid (the spec is "Luhn-valid number whose prefix doesn't match").
      expect(validateLuhn(out)).toBe(true);
    }
  });

  test("default (no validity arg) is still byte-identical to validity=valid", async () => {
    const noArg = await creditCardGenerator.generate(
      { brand: "visa" } as unknown as { brand: "visa"; validity: "valid" },
      makeCtx({ seed: "cc-default" }),
    );
    const explicit = await creditCardGenerator.generate(
      { brand: "visa", validity: "valid" },
      makeCtx({ seed: "cc-default" }),
    );
    expect(noArg).toBe(explicit);
  });
});

// -- iban validity -----------------------------------------------------------

describe("iban validity", () => {
  const COUNTRY = "DE";

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "iban -- mode=%s -- determinism (same seed -> same output)",
    async (mode) => {
      if (!isSupported("iban", mode)) return;
      const a = await ibanGenerator.generate(
        { country: COUNTRY, validity: mode },
        makeCtx({ seed: "iban-det" }),
      );
      const b = await ibanGenerator.generate(
        { country: COUNTRY, validity: mode },
        makeCtx({ seed: "iban-det" }),
      );
      expect(a).toBe(b);
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "iban -- mode=%s -- validator round-trip",
    async (mode) => {
      if (!isSupported("iban", mode)) return;
      const out = await ibanGenerator.generate(
        { country: COUNTRY, validity: mode },
        makeCtx({ seed: `iban-rt-${mode}` }),
      );
      if (mode === "valid") {
        expect(validateIbanStrict(out)).toBe(true);
      } else {
        expect(validateIbanStrict(out)).toBe(false);
      }
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "iban -- mode=%s -- distinct from valid (same seed)",
    async (mode) => {
      if (!isSupported("iban", mode) || mode === "valid") return;
      const seed = `iban-dist-${mode}`;
      const validOut = await ibanGenerator.generate(
        { country: COUNTRY, validity: "valid" },
        makeCtx({ seed }),
      );
      const invalidOut = await ibanGenerator.generate(
        { country: COUNTRY, validity: mode },
        makeCtx({ seed }),
      );
      expect(invalidOut).not.toBe(validOut);
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "iban -- unsupported mode=%s throws unsupported-validity-mode",
    async (mode) => {
      if (isSupported("iban", mode)) return;
      expect(() =>
        ibanGenerator.generate(
          { country: COUNTRY, validity: mode },
          makeCtx({ seed: "iban-throw" }),
        ),
      ).toThrow(new RegExp(`unsupported-validity-mode: ${mode}`));
    },
  );

  test("invalid-country -- starts with XX, length 22, mod-97 still passes (so the failure isolates to country lookup)", async () => {
    const out = await ibanGenerator.generate(
      { country: COUNTRY, validity: "invalid-country" },
      makeCtx({ seed: "iban-xx" }),
    );
    expect(out.startsWith("XX")).toBe(true);
    expect(out.length).toBe(22);
    // The composite rejects (unsupported country) but the bare mod-97 passes,
    // so the variant is failing for one reason only -- unknown CC.
    expect(validateIbanStrict(out)).toBe(false);
    expect(validateIban(out)).toBe(true);
  });

  test("invalid-checksum keeps country + length but breaks mod-97", async () => {
    const out = await ibanGenerator.generate(
      { country: COUNTRY, validity: "invalid-checksum" },
      makeCtx({ seed: "iban-bc" }),
    );
    expect(out.startsWith(COUNTRY)).toBe(true);
    expect(out.length).toBe(IBAN_LENGTHS[COUNTRY]);
    expect(validateIban(out)).toBe(false);
  });

  test("default (no validity arg) is still byte-identical to validity=valid", async () => {
    const noArg = await ibanGenerator.generate(
      { country: "DE" } as unknown as { country: string; validity: "valid" },
      makeCtx({ seed: "iban-default" }),
    );
    const explicit = await ibanGenerator.generate(
      { country: "DE", validity: "valid" },
      makeCtx({ seed: "iban-default" }),
    );
    expect(noArg).toBe(explicit);
  });
});

// -- swift-bic validity ------------------------------------------------------

describe("swift-bic validity", () => {
  const LEN = 8 as const;

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "swift-bic -- mode=%s -- determinism (same seed -> same output)",
    async (mode) => {
      if (!isSupported("swift-bic", mode)) return;
      const a = await swiftBicGenerator.generate(
        { length: LEN, validity: mode },
        makeCtx({ seed: "swift-det" }),
      );
      const b = await swiftBicGenerator.generate(
        { length: LEN, validity: mode },
        makeCtx({ seed: "swift-det" }),
      );
      expect(a).toBe(b);
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "swift-bic -- mode=%s -- validator round-trip",
    async (mode) => {
      if (!isSupported("swift-bic", mode)) return;
      const out = await swiftBicGenerator.generate(
        { length: LEN, validity: mode },
        makeCtx({ seed: `swift-rt-${mode}` }),
      );
      if (mode === "valid") {
        expect(validateSwiftBic(out, LEN)).toBe(true);
      } else {
        expect(validateSwiftBic(out, LEN)).toBe(false);
      }
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "swift-bic -- mode=%s -- distinct from valid (same seed)",
    async (mode) => {
      if (!isSupported("swift-bic", mode) || mode === "valid") return;
      const seed = `swift-dist-${mode}`;
      const validOut = await swiftBicGenerator.generate(
        { length: LEN, validity: "valid" },
        makeCtx({ seed }),
      );
      const invalidOut = await swiftBicGenerator.generate(
        { length: LEN, validity: mode },
        makeCtx({ seed }),
      );
      expect(invalidOut).not.toBe(validOut);
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "swift-bic -- unsupported mode=%s throws unsupported-validity-mode",
    async (mode) => {
      if (isSupported("swift-bic", mode)) return;
      expect(() =>
        swiftBicGenerator.generate(
          { length: LEN, validity: mode },
          makeCtx({ seed: "swift-throw" }),
        ),
      ).toThrow(new RegExp(`unsupported-validity-mode: ${mode}`));
    },
  );

  test("default (no validity arg) is still byte-identical to validity=valid", async () => {
    const noArg = await swiftBicGenerator.generate(
      { length: 8 } as unknown as { length: 8; validity: "valid" },
      makeCtx({ seed: "swift-default" }),
    );
    const explicit = await swiftBicGenerator.generate(
      { length: 8, validity: "valid" },
      makeCtx({ seed: "swift-default" }),
    );
    expect(noArg).toBe(explicit);
  });
});

// -- routing-number validity -------------------------------------------------

describe("routing-number validity", () => {
  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "routing-number -- mode=%s -- determinism (same seed -> same output)",
    async (mode) => {
      if (!isSupported("routing-number", mode)) return;
      const a = await routingGenerator.generate(
        { validity: mode },
        makeCtx({ seed: "aba-det" }),
      );
      const b = await routingGenerator.generate(
        { validity: mode },
        makeCtx({ seed: "aba-det" }),
      );
      expect(a).toBe(b);
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "routing-number -- mode=%s -- validator round-trip",
    async (mode) => {
      if (!isSupported("routing-number", mode)) return;
      const out = await routingGenerator.generate(
        { validity: mode },
        makeCtx({ seed: `aba-rt-${mode}` }),
      );
      if (mode === "valid") {
        expect(validateAba(out)).toBe(true);
      } else {
        expect(validateAba(out)).toBe(false);
      }
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "routing-number -- mode=%s -- distinct from valid (same seed)",
    async (mode) => {
      if (!isSupported("routing-number", mode) || mode === "valid") return;
      const seed = `aba-dist-${mode}`;
      const validOut = await routingGenerator.generate(
        { validity: "valid" },
        makeCtx({ seed }),
      );
      const invalidOut = await routingGenerator.generate(
        { validity: mode },
        makeCtx({ seed }),
      );
      expect(invalidOut).not.toBe(validOut);
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "routing-number -- unsupported mode=%s throws unsupported-validity-mode",
    async (mode) => {
      if (isSupported("routing-number", mode)) return;
      expect(() =>
        routingGenerator.generate(
          { validity: mode },
          makeCtx({ seed: "aba-throw" }),
        ),
      ).toThrow(new RegExp(`unsupported-validity-mode: ${mode}`));
    },
  );

  test("default (no validity arg) is still byte-identical to validity=valid", async () => {
    const noArg = await routingGenerator.generate(
      undefined,
      makeCtx({ seed: "aba-default" }),
    );
    const explicit = await routingGenerator.generate(
      { validity: "valid" },
      makeCtx({ seed: "aba-default" }),
    );
    expect(noArg).toBe(explicit);
  });
});

// -- isbn-13 validity --------------------------------------------------------

describe("isbn-13 validity", () => {
  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "isbn-13 -- mode=%s -- determinism (same seed -> same output)",
    async (mode) => {
      if (!isSupported("isbn-13", mode)) return;
      const a = await isbn13Generator.generate(
        { validity: mode },
        makeCtx({ seed: "isbn-det" }),
      );
      const b = await isbn13Generator.generate(
        { validity: mode },
        makeCtx({ seed: "isbn-det" }),
      );
      expect(a).toBe(b);
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "isbn-13 -- mode=%s -- validator round-trip",
    async (mode) => {
      if (!isSupported("isbn-13", mode)) return;
      const out = await isbn13Generator.generate(
        { validity: mode },
        makeCtx({ seed: `isbn-rt-${mode}` }),
      );
      if (mode === "valid") {
        expect(validateIsbn13(out)).toBe(true);
      } else {
        expect(validateIsbn13(out)).toBe(false);
      }
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "isbn-13 -- mode=%s -- distinct from valid (same seed)",
    async (mode) => {
      if (!isSupported("isbn-13", mode) || mode === "valid") return;
      const seed = `isbn-dist-${mode}`;
      const validOut = await isbn13Generator.generate(
        { validity: "valid" },
        makeCtx({ seed }),
      );
      const invalidOut = await isbn13Generator.generate(
        { validity: mode },
        makeCtx({ seed }),
      );
      expect(invalidOut).not.toBe(validOut);
    },
  );

  test.each(VALIDITY_MODES.map((m) => [m] as [ValidityMode]))(
    "isbn-13 -- unsupported mode=%s throws unsupported-validity-mode",
    async (mode) => {
      if (isSupported("isbn-13", mode)) return;
      expect(() =>
        isbn13Generator.generate(
          { validity: mode },
          makeCtx({ seed: "isbn-throw" }),
        ),
      ).toThrow(new RegExp(`unsupported-validity-mode: ${mode}`));
    },
  );

  test("invalid-prefix -- uses 977 (ISSN region), check digit locally correct", async () => {
    const out = await isbn13Generator.generate(
      { validity: "invalid-prefix" },
      makeCtx({ seed: "isbn-ip" }),
    );
    expect(out.startsWith("977")).toBe(true);
    expect(out.length).toBe(13);
    // The check digit is locally correct (alternating-weight mod-10 = 0)
    // BUT the prefix rule rejects.
    let sum = 0;
    for (let i = 0; i < 13; i++) {
      sum += Number(out[i]) * (i % 2 === 0 ? 1 : 3);
    }
    expect(sum % 10).toBe(0);
    // Composite validator (validateIsbn13) rejects because prefix is wrong.
    expect(validateIsbn13(out)).toBe(false);
  });

  test("default (no validity arg) is still byte-identical to validity=valid", async () => {
    const noArg = await isbn13Generator.generate(
      undefined,
      makeCtx({ seed: "isbn-default" }),
    );
    const explicit = await isbn13Generator.generate(
      { validity: "valid" },
      makeCtx({ seed: "isbn-default" }),
    );
    expect(noArg).toBe(explicit);
  });
});
