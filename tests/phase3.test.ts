import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { checkReading, needsSecondLook, normalizeReading } from "../convex/lib/reading";
import { addUser, as, newT } from "./setup";

const good = {
  is_receipt: true,
  vendor: "Walmart Supercenter",
  date: "2026-11-18",
  subtotal: 39.98,
  tax: 3.29,
  total: 43.27,
  payment_method: "Visa",
  card_last4: "**** 4417",
  items: [{ description: "Water 24pk", quantity: 2, amount: 11.96 }, { description: "Snack mix", quantity: 3, amount: 28.02 }],
  confidence: { vendor: "high", date: "high", total: "high" },
};
const today = new Date("2026-11-19T18:00:00Z");

describe("T3.1 cleaning up what Claude returns", () => {
  test("money strings become numbers; card keeps last 4 only; bad dates dropped", () => {
    const r = normalizeReading({ ...good, total: "$43.27", tax: "3.29", card_last4: "4111 1111 1111 4417", date: "11/18/26" });
    expect(r.total).toBe(43.27);
    expect(r.tax).toBe(3.29);
    expect(r.cardLast4).toBe("4417");
    expect(r.date).toBeUndefined();
  });
  test("junk shapes don't throw", () => {
    const r = normalizeReading({ items: "nope", confidence: null } as unknown as Record<string, unknown>);
    expect(r.items).toEqual([]);
    expect(r.confidence).toEqual({ vendor: "low", date: "low", total: "low" });
  });
});

describe("T3.2 'check this' flags", () => {
  test("a clean receipt has no flags", () => {
    expect(checkReading(normalizeReading(good), today)).toEqual({});
  });
  test("numbers that don't add up are flagged", () => {
    const f = checkReading(normalizeReading({ ...good, total: 45 }), today);
    expect(f.total).toMatch(/add up/);
  });
  test("restaurant: subtotal + tax + handwritten tip = total is clean", () => {
    const r = normalizeReading({ ...good, items: [], subtotal: 40, tax: 3.4, tip: 8, total: 51.4 });
    expect(checkReading(r, today)).toEqual({});
  });
  test("low confidence, missing and odd dates are flagged", () => {
    const f = checkReading(normalizeReading({ ...good, vendor: null, date: "2019-01-02", confidence: { vendor: "high", date: "high", total: "low" } }), today);
    expect(f.vendor).toBe("Missing");
    expect(f.date).toMatch(/Unusual/);
    expect(f.total).toBeTruthy();
  });
  test("items that don't match the subtotal are flagged", () => {
    const f = checkReading(normalizeReading({ ...good, items: [{ description: "x", amount: 5 }] }), today);
    expect(f.items).toBeTruthy();
  });
  test("second look only when the total/date/vendor are shaky", () => {
    const clean = normalizeReading(good);
    expect(needsSecondLook(clean, checkReading(clean, today))).toBe(false);
    const shaky = normalizeReading({ ...good, confidence: { vendor: "high", date: "high", total: "medium" } });
    expect(needsSecondLook(shaky, checkReading(shaky, today))).toBe(true);
  });
});

// A fake Claude: each call returns the next scripted tool input.
function fakeClaude(...answers: Array<Record<string, unknown> | "error">) {
  const calls: Array<{ model: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ model: body.model });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a === "error") return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "record_receipt", input: a }] }), { status: 200 });
  }));
  return calls;
}

async function draftWithPhoto(t: ReturnType<typeof newT>, userId: Awaited<ReturnType<typeof addUser>>) {
  const photo = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: "image/jpeg" })));
  return t.run((ctx) => ctx.db.insert("receipts", { userId, status: "draft", photo, read: "reading", createdAt: Date.now() }));
}

describe("T3.3 reading flow (Claude mocked)", () => {
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = "test"; process.env.ADMIN_EMAILS = ""; });
  afterEach(() => vi.unstubAllGlobals());

  test("clean fast read: one call to the fast model, fields saved", async () => {
    const t = newT();
    const uid = await addUser(t, "pat@icgadv.com", "crew");
    const id = await draftWithPhoto(t, uid);
    const calls = fakeClaude(good);
    await t.action(internal.receipts.readPhoto, { id });
    expect(calls.map((c) => c.model)).toEqual(["claude-haiku-5-5"]);
    const r = await t.run((ctx) => ctx.db.get(id));
    expect(r).toMatchObject({ read: "done", vendor: "Walmart Supercenter", total: 43.27, cardLast4: "4417", readModel: "claude-haiku-5-5" });
  });

  test("shaky fast read gets a second look from the stronger model, which wins", async () => {
    const t = newT();
    const uid = await addUser(t, "pat@icgadv.com", "crew");
    const id = await draftWithPhoto(t, uid);
    const calls = fakeClaude({ ...good, total: 4.327, confidence: { vendor: "high", date: "high", total: "low" } }, good);
    await t.action(internal.receipts.readPhoto, { id });
    expect(calls.map((c) => c.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect((await t.run((ctx) => ctx.db.get(id)))?.total).toBe(43.27);
  });

  test("fast model down → stronger model reads it", async () => {
    const t = newT();
    const uid = await addUser(t, "pat@icgadv.com", "crew");
    const id = await draftWithPhoto(t, uid);
    const calls = fakeClaude("error", good);
    await t.action(internal.receipts.readPhoto, { id });
    expect(calls).toHaveLength(2);
    expect((await t.run((ctx) => ctx.db.get(id)))?.read).toBe("done");
  });

  test("both down → marked failed with a plain message (no crash)", async () => {
    const t = newT();
    const uid = await addUser(t, "pat@icgadv.com", "crew");
    const id = await draftWithPhoto(t, uid);
    fakeClaude("error");
    await t.action(internal.receipts.readPhoto, { id });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ read: "failed", readError: "Couldn't read it this time." });
  });

  test("no API key → 'not set up yet'", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const t = newT();
    const uid = await addUser(t, "pat@icgadv.com", "crew");
    const id = await draftWithPhoto(t, uid);
    fakeClaude(good);
    await t.action(internal.receipts.readPhoto, { id });
    expect((await t.run((ctx) => ctx.db.get(id)))?.readError).toMatch(/isn't set up/);
  });
});

describe("T3.4 who can see and change a receipt", () => {
  beforeEach(() => { process.env.ADMIN_EMAILS = ""; });

  test("create refuses non-images and removes the file", async () => {
    const t = newT();
    const pat = await as(t, await addUser(t, "pat@icgadv.com", "crew"));
    const file = await t.run((ctx) => ctx.storage.store(new Blob(["hello"], { type: "text/plain" })));
    expect(await pat.mutation(api.receipts.create, { photo: file })).toEqual({ error: "That file isn't a photo the app can read." });
    expect(await t.run((ctx) => ctx.storage.getUrl(file))).toBeNull();
  });

  test("owner sees and edits; other crew can't; admin can see but not edit", async () => {
    const t = newT();
    const patId = await addUser(t, "pat@icgadv.com", "crew");
    const pat = await as(t, patId);
    const sam = await as(t, await addUser(t, "sam@icgadv.com", "crew"));
    const boss = await as(t, await addUser(t, "boss@icgadv.com", "admin"));
    const id = await draftWithPhoto(t, patId);
    expect(await pat.query(api.receipts.get, { id })).not.toBeNull();
    expect(await sam.query(api.receipts.get, { id })).toBeNull();
    expect(await boss.query(api.receipts.get, { id })).not.toBeNull();
    await expect(sam.mutation(api.receipts.update, { id, total: 1 })).rejects.toThrow(/not found/);
    await expect(boss.mutation(api.receipts.update, { id, total: 1 })).rejects.toThrow(/Only the person/);
    await expect(sam.mutation(api.receipts.discard, { id })).rejects.toThrow();
  });

  test("editing clears that field's flag and re-checks the math; edits are recorded", async () => {
    const t = newT();
    const patId = await addUser(t, "pat@icgadv.com", "crew");
    const pat = await as(t, patId);
    const id = await draftWithPhoto(t, patId);
    fakeClaude({ ...good, total: 45, confidence: { vendor: "high", date: "high", total: "low" } });
    process.env.ANTHROPIC_API_KEY = "test";
    await t.action(internal.receipts.readPhoto, { id });
    vi.unstubAllGlobals();
    expect((await t.run((ctx) => ctx.db.get(id)))?.flags?.total).toBeTruthy();
    await pat.mutation(api.receipts.update, { id, total: 43.27 });
    const r = await t.run((ctx) => ctx.db.get(id));
    expect(r?.flags ?? {}).toEqual({});
    expect(r?.edited).toEqual(["total"]);
    await expect(pat.mutation(api.receipts.update, { id, cardLast4: "12" })).rejects.toThrow(/last 4/);
    await expect(pat.mutation(api.receipts.update, { id, date: "Nov 3" })).rejects.toThrow(/full date/);
  });

  test("discard removes the draft and its photo; my drafts list follows", async () => {
    const t = newT();
    const patId = await addUser(t, "pat@icgadv.com", "crew");
    const pat = await as(t, patId);
    const id = await draftWithPhoto(t, patId);
    expect(await pat.query(api.receipts.myDrafts, {})).toHaveLength(1);
    const photo = (await t.run((ctx) => ctx.db.get(id)))!.photo;
    await pat.mutation(api.receipts.discard, { id });
    expect(await pat.query(api.receipts.myDrafts, {})).toHaveLength(0);
    expect(await t.run((ctx) => ctx.storage.getUrl(photo))).toBeNull();
  });
});
