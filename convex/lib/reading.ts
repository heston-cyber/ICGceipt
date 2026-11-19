// Reading a receipt photo with Claude: the tool schema Claude fills in, and the checks on what comes back.
// Pure functions (no Convex), so they're tested directly.

export type Confidence = "high" | "medium" | "low";
export type Item = { description: string; quantity?: number; amount?: number };
export type Reading = {
  isReceipt: boolean;
  vendor?: string;
  vendorAddress?: string;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:MM (24h)
  subtotal?: number;
  tax?: number;
  tip?: number;
  total?: number;
  currency?: string;
  paymentMethod?: string; // "Visa", "Cash", "Apple Pay"…
  cardLast4?: string;
  items: Item[];
  categoryHint?: string;
  confidence: { vendor: Confidence; date: Confidence; total: Confidence };
  notes?: string;
};

/** Fields the reviewer should check: low/medium confidence, missing, or numbers that don't add up. */
export type Flags = Partial<Record<"vendor" | "date" | "total" | "subtotal" | "tax" | "tip" | "items", string>>;

export const RECEIPT_TOOL = {
  name: "record_receipt",
  description: "Record what the receipt photo says. Use null for anything not printed or not readable. Never guess numbers.",
  input_schema: {
    type: "object",
    properties: {
      is_receipt: { type: "boolean", description: "False if the photo isn't a receipt, invoice or bill." },
      vendor: { type: ["string", "null"], description: "Business name as printed, tidied (e.g. 'Walmart Supercenter')." },
      vendor_address: { type: ["string", "null"], description: "City and state, or full address if short." },
      date: { type: ["string", "null"], description: "Purchase date as YYYY-MM-DD." },
      time: { type: ["string", "null"], description: "Purchase time as HH:MM, 24-hour." },
      subtotal: { type: ["number", "null"] },
      tax: { type: ["number", "null"], description: "Total tax. Add up several tax lines." },
      tip: { type: ["number", "null"], description: "Tip or gratuity, including one written in by hand." },
      total: { type: ["number", "null"], description: "Final amount paid, including any handwritten tip total." },
      currency: { type: ["string", "null"], description: "ISO code, e.g. USD." },
      payment_method: { type: ["string", "null"], description: "Card brand, Cash, Apple Pay, etc." },
      card_last4: { type: ["string", "null"], description: "Only the last 4 digits of the card, if printed." },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            quantity: { type: ["number", "null"] },
            amount: { type: ["number", "null"], description: "Line total." },
          },
          required: ["description"],
        },
      },
      category_hint: { type: ["string", "null"], description: "One or two words: what kind of spend this looks like (food, fuel, hardware…)." },
      confidence: {
        type: "object",
        description: "How sure you are of each, from the photo alone.",
        properties: {
          vendor: { type: "string", enum: ["high", "medium", "low"] },
          date: { type: "string", enum: ["high", "medium", "low"] },
          total: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["vendor", "date", "total"],
      },
      notes: { type: ["string", "null"], description: "Only if something is wrong with the receipt or photo that affects the numbers (faded, cut off, two receipts, a refund, a total you couldn't read). One short sentence. Otherwise null. Never comment on what the purchase was for." },
    },
    required: ["is_receipt", "items", "confidence"],
  },
} as const;

export const RECEIPT_PROMPT =
  "This is a photo of a receipt, taken on a phone. Read it carefully and call record_receipt. " +
  "Amounts are plain numbers (12.5, not '$12.50'). Dates are YYYY-MM-DD; if the year is printed as two digits, assume 20xx. " +
  "If a tip was written in by hand, include it and use the handwritten total. Only give the last 4 digits of any card number. " +
  "Say low confidence rather than guessing. Leave notes null unless something affects the numbers.";

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100) / 100;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    if (v.trim() && Number.isFinite(n)) return Math.round(n * 100) / 100;
  }
  return undefined;
};
const str = (v: unknown, max = 200): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
};
const conf = (v: unknown): Confidence => (v === "high" || v === "medium" || v === "low" ? v : "low");

/** Turns Claude's tool input into clean, typed fields (bad shapes become "missing", never errors). */
export function normalizeReading(raw: Record<string, unknown>): Reading {
  const c = (raw.confidence ?? {}) as Record<string, unknown>;
  let date = str(raw.date, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = undefined;
  let time = str(raw.time, 5);
  if (time && !/^\d{1,2}:\d{2}$/.test(time)) time = undefined;
  const last4 = str(raw.card_last4)?.replace(/\D/g, "").slice(-4);
  const items = Array.isArray(raw.items)
    ? raw.items.slice(0, 80).flatMap((i) => {
        const o = (i ?? {}) as Record<string, unknown>;
        const description = str(o.description, 120);
        return description ? [{ description, quantity: num(o.quantity), amount: num(o.amount) }] : [];
      })
    : [];
  return {
    isReceipt: raw.is_receipt !== false,
    vendor: str(raw.vendor, 120),
    vendorAddress: str(raw.vendor_address, 160),
    date,
    time,
    subtotal: num(raw.subtotal),
    tax: num(raw.tax),
    tip: num(raw.tip),
    total: num(raw.total),
    currency: str(raw.currency, 3)?.toUpperCase(),
    paymentMethod: str(raw.payment_method, 40),
    cardLast4: last4 && last4.length === 4 ? last4 : undefined,
    items,
    categoryHint: str(raw.category_hint, 40),
    confidence: { vendor: conf(c.vendor), date: conf(c.date), total: conf(c.total) },
    notes: str(raw.notes, 400),
  };
}

const cents = (n: number) => Math.round(n * 100);

/** What the reviewer should double-check. Empty = looks clean. */
export function checkReading(r: Reading, today = new Date()): Flags {
  const f: Flags = {};
  if (!r.isReceipt) return f;
  if (!r.vendor) f.vendor = "Missing";
  else if (r.confidence.vendor !== "high") f.vendor = "Check the name";
  if (!r.date) f.date = "Missing";
  else {
    if (r.confidence.date !== "high") f.date = "Check the date";
    const d = new Date(r.date + "T12:00:00Z");
    const ageDays = (today.getTime() - d.getTime()) / 86400000;
    if (Number.isNaN(ageDays) || ageDays < -2 || ageDays > 400) f.date = "Unusual date — check it";
  }
  if (r.total === undefined) f.total = "Missing";
  else {
    if (r.total <= 0) f.total = "Check the total";
    else if (r.confidence.total !== "high") f.total = "Check the total";
    // Subtotal + tax + tip should equal the total (within a cent or two of rounding).
    if (r.subtotal !== undefined) {
      const sum = cents(r.subtotal) + cents(r.tax ?? 0) + cents(r.tip ?? 0);
      if (Math.abs(sum - cents(r.total)) > 2) f.total = "Doesn't add up — check total, tax and tip";
    }
  }
  // Line items should add up to the subtotal when every line has an amount.
  const amounts = r.items.map((i) => i.amount);
  if (r.subtotal !== undefined && amounts.length && amounts.every((a) => a !== undefined)) {
    const sum = amounts.reduce((s, a) => s + cents(a!), 0);
    if (Math.abs(sum - cents(r.subtotal)) > 2) f.items = "Items don't add up to the subtotal";
  }
  return f;
}

/** Ask the stronger model when the fast read is shaky on the things that matter. */
export function needsSecondLook(r: Reading, flags: Flags): boolean {
  if (!r.isReceipt) return r.confidence.total !== "high"; // double-check a "not a receipt" unless it's sure
  return Boolean(flags.total || flags.date || flags.vendor === "Missing");
}
