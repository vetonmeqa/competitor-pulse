const SYMBOL_TO_CODE: Readonly<Record<string, string>> = { $: "USD", "€": "EUR", "£": "GBP" };
const CODE_TO_SYMBOL: Readonly<Record<string, string>> = { USD: "$", EUR: "€", GBP: "£" };

/** Spellings of the same billing unit, mapped to the short form used in the canonical price. */
const UNIT_ALIASES: Readonly<Record<string, string>> = {
  mo: "mo",
  month: "mo",
  monthly: "mo",
  yr: "yr",
  year: "yr",
  yearly: "yr",
  annually: "yr",
  seat: "seat",
  user: "seat",
};

const FREE = "Free";

// "$29/mo", "€8 / seat / month", "USD 29 per month", "CHF 5/mo", "$1,299.00/yr"
const PRICE_PATTERN =
  /^(?:(?<symbol>[$€£])|(?<code>[A-Za-z]{3})\s+)\s*(?<amount>\d[\d,]*(?:\.\d+)?)\s*(?<period>.*)$/;

/**
 * Rewrites a price in one canonical form, so that the same price written in different
 * ways compares equal: "$29/mo", "$29.00/mo", "$29 / month" and "USD 29 per month"
 * all become "$29/mo". Any zero price becomes "Free".
 *
 * A price that does not fit the expected shape (for example "Contact sales") is returned
 * unchanged and compared as plain text. That can report a change that is only a
 * reformatting, which is safer than hiding a real one.
 *
 * Expects text that already went through `normalizeText`.
 */
export function normalizePrice(text: string): string {
  if (/^free(?: forever)?$/i.test(text)) {
    return FREE;
  }

  const groups = PRICE_PATTERN.exec(text)?.groups;
  if (!groups) {
    return text;
  }
  const { symbol, code, amount: rawAmount, period: rawPeriod } = groups;
  if (rawAmount === undefined || rawPeriod === undefined) {
    return text;
  }

  const amount = Number(rawAmount.replaceAll(",", ""));
  const period = parsePeriod(rawPeriod);
  if (!Number.isFinite(amount) || period === null) {
    return text;
  }
  if (amount === 0) {
    return FREE;
  }

  const currencyCode = symbol ? SYMBOL_TO_CODE[symbol] : code?.toUpperCase();
  if (currencyCode === undefined) {
    return text;
  }
  const currency = CODE_TO_SYMBOL[currencyCode] ?? `${currencyCode} `;
  const formattedAmount = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${currency}${formattedAmount}${period}`;
}

/**
 * "/mo", " / seat / month" and "per seat per month" -> "/mo", "/seat/mo", "/seat/mo".
 * Returns "" for a price with no period, and null when the text is not a period at all.
 */
function parsePeriod(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (text === "") {
    return "";
  }
  if (!text.startsWith("/") && !text.startsWith("per ")) {
    return null;
  }
  const units = text
    .split(/\/|\bper\b/)
    .map((unit) => unit.trim())
    .filter((unit) => unit !== "");
  if (units.length === 0) {
    return null;
  }
  return units.map((unit) => `/${UNIT_ALIASES[unit] ?? unit}`).join("");
}
