import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { dupKey, receiptMail, receiptNo, sheetRow } from "../convex/lib/receiptMail";
import { addUser, as, newT, type T } from "./setup";

type Call = { url: string; body: Record<string, unknown> };
function fakeNet(opts: { sheet?: "ok" | "fail" | "html"; email?: "ok" | "fail" } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    if (url.includes("resend.com")) return opts.email === "fail" ? new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 }) : new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    if (opts.sheet === "html") return new Response("<html>Sign in</html>", { status: 200 });
    return new Response(JSON.stringify(opts.sheet === "fail" ? { ok: false, error: "Wrong or missing secret" } : { ok: true }), { status: 200 });
  }));
  return calls;
}

async function setup(t: T) {
  const patId = await addUser(t, "pat@icgadv.com", "crew", { name: "Pat Lee" });
  const pat = await as(t, patId);
  const photo = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array([0xff, 0xd8, 1, 2])], { type: "image/jpeg" })));
  const id = await t.run((ctx) => ctx.db.insert("receipts", {
    userId: patId, status: "draft", photo, read: "done", vendor: "Walmart Supercenter", date: "2026-11-18",
    subtotal: 39.98, tax: 3.29, total: 43.27, paymentMethod: "Visa", cardLast4: "4417", createdAt: Date.now(),
    items: [{ description: "Water 24pk", quantity: 2, amount: 11.96 }],
  }));
  await pat.mutation(api.tags.ensureDefaults, {});
  const clientId = await pat.mutation(api.tags.addClient, { name: "Floor Trader" });
  const shootId = await pat.mutation(api.tags.addShoot, { clientId, name: "Backrooms spot" });
  const lists = await pat.query(api.tags.lists, {});
  const categoryId = lists.categories.find((c) => c.name === "Crafty")!._id as Id<"categories">;
  return { patId, pat, id, clientId, shootId, categoryId };
}

beforeEach(() => {
  process.env.ADMIN_EMAILS = "";
  process.env.RESEND_API_KEY = "test";
  process.env.EMAIL_FROM = "ICGceipt <receipts@hillsbuilds.com>";
  process.env.ICG_SHEET_URL = "https://script.google.com/macros/s/abc/exec";
  process.env.ICG_SHEET_SECRET = "s3cret";
  delete process.env.EMAIL_ONLY_TO;
});
afterEach(() => vi.unstubAllGlobals());

describe("T4.1 clients › shoots, categories", () => {
  test("starter categories appear once; adding an existing name reuses it (any case)", async () => {
    const t = newT();
    const { pat, clientId } = await setup(t);
    await pat.mutation(api.tags.ensureDefaults, {});
    const lists = await pat.query(api.tags.lists, {});
    expect(lists.categories.map((c) => c.name)).toContain("Crafty");
    expect(lists.categories.filter((c) => c.name === "Crafty")).toHaveLength(1);
    expect(await pat.mutation(api.tags.addClient, { name: "  floor   trader " })).toBe(clientId);
  });

  test("crew can add but not rename or delete; admin can", async () => {
    const t = newT();
    const { pat, clientId } = await setup(t);
    await expect(pat.mutation(api.tags.rename, { kind: "clients", id: clientId, name: "FT" })).rejects.toThrow(/admin/);
    await expect(pat.mutation(api.tags.remove, { kind: "clients", id: clientId })).rejects.toThrow(/admin/);
    const boss = await as(t, await addUser(t, "boss@icgadv.com", "admin"));
    await boss.mutation(api.tags.rename, { kind: "clients", id: clientId, name: "Floor Trader Inc" });
    expect((await pat.query(api.tags.lists, {})).clients[0].name).toBe("Floor Trader Inc");
  });

  test("delete: unused → gone; in use → archived (hidden, kept on old receipts)", async () => {
    const t = newT();
    const { pat, id, clientId, shootId, categoryId } = await setup(t);
    const boss = await as(t, await addUser(t, "boss@icgadv.com", "admin"));
    const spare = await pat.mutation(api.tags.addCategory, { name: "Misc" });
    expect(await boss.mutation(api.tags.remove, { kind: "categories", id: spare })).toBe("deleted");
    fakeNet();
    await pat.mutation(api.receipts.send, { id, clientId, shootId, categoryId, to: ["acct@icgadv.com"] });
    expect(await boss.mutation(api.tags.remove, { kind: "clients", id: clientId })).toBe("archived");
    const lists = await pat.query(api.tags.lists, {});
    expect(lists.clients).toHaveLength(0);
    expect(lists.shoots).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(id)))?.clientName).toBe("Floor Trader");
  });
});

describe("T4.2 recipients", () => {
  test("shared list (admin) + own saved extras (anyone); can't remove someone else's", async () => {
    const t = newT();
    const { pat } = await setup(t);
    const boss = await as(t, await addUser(t, "boss@icgadv.com", "admin"));
    await expect(pat.mutation(api.recipients.addShared, { email: "acct@icgadv.com" })).rejects.toThrow(/admin/);
    await boss.mutation(api.recipients.addShared, { email: "Acct@ICGadv.com", name: "Accounting", isDefault: true });
    await pat.mutation(api.recipients.saveMine, { email: "producer@icgadv.com" });
    const mine = await pat.query(api.recipients.mine, {});
    expect(mine.shared).toEqual([expect.objectContaining({ email: "acct@icgadv.com", isDefault: true })]);
    expect(mine.own.map((r) => r.email)).toEqual(["producer@icgadv.com"]);
    const bossOwn = await boss.query(api.recipients.mine, {});
    expect(bossOwn.own).toHaveLength(0);
    await expect(boss.mutation(api.recipients.remove, { id: mine.own[0]._id })).rejects.toThrow(/can't remove/);
  });
});

describe("T4.3 sending", () => {
  test("numbers it, sends the email on the sender's behalf with the photo, writes the Sheet row", async () => {
    vi.useFakeTimers();
    const t = newT();
    const { pat, id, clientId, shootId, categoryId } = await setup(t);
    const calls = fakeNet();
    const res = await pat.mutation(api.receipts.send, { id, clientId, shootId, categoryId, note: "crew water", to: ["Acct@icgadv.com", "acct@icgadv.com"] });
    expect(res).toEqual({ number: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const mail = calls.find((c) => c.url.includes("resend.com"))!.body;
    expect(mail.from).toBe('"Pat Lee via ICGceipt" <receipts@hillsbuilds.com>');
    expect(mail.to).toEqual(["acct@icgadv.com"]);
    expect(mail.cc).toEqual(["pat@icgadv.com"]);
    expect(mail.reply_to).toBe("pat@icgadv.com");
    expect(mail.subject).toBe("Receipt · $43.27 · Crafty · Floor Trader › Backrooms spot · Pat Lee");
    expect((mail.attachments as Array<{ filename: string }>)[0].filename).toBe("ICG-0001_2026-11-18_Walmart-Supercenter.jpg");
    const sheet = calls.find((c) => c.url.includes("script.google.com"))!.body;
    expect(sheet.secret).toBe("s3cret");
    expect(sheet.row).toMatchObject({ "Receipt #": "ICG-0001", Client: "Floor Trader", Shoot: "Backrooms spot", Category: "Crafty", Total: 43.27, "Sent by": "Pat Lee", Note: "crew water" });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "sent", number: 1, emailStatus: "sent", sheetStatus: "done" });
  });

  test("the same receipt twice warns first; confirming sends it as the next number", async () => {
    vi.useFakeTimers();
    const t = newT();
    const s = await setup(t);
    fakeNet();
    await s.pat.mutation(api.receipts.send, { id: s.id, clientId: s.clientId, categoryId: s.categoryId, to: ["a@icgadv.com"] });
    const photo = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array([1])], { type: "image/jpeg" })));
    const id2 = await t.run((ctx) => ctx.db.insert("receipts", { userId: s.patId, status: "draft", photo, read: "done", vendor: "WALMART SUPERCENTER", date: "2026-11-18", total: 43.27, createdAt: Date.now() }));
    const warn = await s.pat.mutation(api.receipts.send, { id: id2, clientId: s.clientId, categoryId: s.categoryId, to: ["a@icgadv.com"] });
    expect(warn).toMatchObject({ duplicate: { number: "ICG-0001", by: "Pat Lee" } });
    expect((await t.run((ctx) => ctx.db.get(id2)))?.status).toBe("draft");
    expect(await s.pat.mutation(api.receipts.send, { id: id2, clientId: s.clientId, categoryId: s.categoryId, to: ["a@icgadv.com"], confirmDuplicate: true })).toEqual({ number: 2 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
  });

  test("refuses: missing total, bad email, shoot under another client, someone else's receipt, sending twice", async () => {
    const t = newT();
    const s = await setup(t);
    fakeNet();
    await t.run((ctx) => ctx.db.patch(s.id, { total: undefined }));
    await expect(s.pat.mutation(api.receipts.send, { id: s.id, clientId: s.clientId, categoryId: s.categoryId, to: ["a@b.com"] })).rejects.toThrow(/total/);
    await t.run((ctx) => ctx.db.patch(s.id, { total: 43.27 }));
    await expect(s.pat.mutation(api.receipts.send, { id: s.id, clientId: s.clientId, categoryId: s.categoryId, to: ["nope"] })).rejects.toThrow(/valid email/);
    await expect(s.pat.mutation(api.receipts.send, { id: s.id, clientId: s.clientId, categoryId: s.categoryId, to: [] })).rejects.toThrow(/at least one/);
    const other = await s.pat.mutation(api.tags.addClient, { name: "UTT" });
    await expect(s.pat.mutation(api.receipts.send, { id: s.id, clientId: other, shootId: s.shootId, categoryId: s.categoryId, to: ["a@b.com"] })).rejects.toThrow(/isn't under/);
    const sam = await as(t, await addUser(t, "sam@icgadv.com", "crew", { name: "Sam" }));
    await expect(sam.mutation(api.receipts.send, { id: s.id, clientId: s.clientId, categoryId: s.categoryId, to: ["a@b.com"] })).rejects.toThrow();
    await s.pat.mutation(api.receipts.send, { id: s.id, clientId: s.clientId, categoryId: s.categoryId, to: ["a@b.com"] });
    await expect(s.pat.mutation(api.receipts.send, { id: s.id, clientId: s.clientId, categoryId: s.categoryId, to: ["a@b.com"] })).rejects.toThrow(/already sent/);
    await expect(s.pat.mutation(api.receipts.update, { id: s.id, total: 1 })).rejects.toThrow(/already sent/);
  });

  test("failures are recorded separately and can be retried; Sheet not set up = 'off'", async () => {
    vi.useFakeTimers();
    const t = newT();
    const s = await setup(t);
    fakeNet({ email: "fail", sheet: "html" });
    await s.pat.mutation(api.receipts.send, { id: s.id, clientId: s.clientId, categoryId: s.categoryId, to: ["a@icgadv.com"] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let r = await t.run((ctx) => ctx.db.get(s.id));
    expect(r).toMatchObject({ emailStatus: "failed", sheetStatus: "failed" });
    expect(r?.emailError).toMatch(/domain not verified/);
    expect(r?.sheetError).toMatch(/Who has access: Anyone/);
    const calls = fakeNet();
    await s.pat.mutation(api.receipts.retryDelivery, { id: s.id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    r = await t.run((ctx) => ctx.db.get(s.id));
    expect(r).toMatchObject({ emailStatus: "sent", sheetStatus: "done" });
    expect(calls).toHaveLength(2);

    delete process.env.ICG_SHEET_URL;
    const photo = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array([1])], { type: "image/jpeg" })));
    const id2 = await t.run((ctx) => ctx.db.insert("receipts", { userId: s.patId, status: "draft", photo, read: "done", vendor: "Shell", date: "2026-11-18", total: 50, createdAt: Date.now() }));
    await s.pat.mutation(api.receipts.send, { id: id2, clientId: s.clientId, categoryId: s.categoryId, to: ["a@icgadv.com"] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    expect((await t.run((ctx) => ctx.db.get(id2)))?.sheetStatus).toBe("off");
  });
});

describe("T4.4 email and Sheet formats", () => {
  const r = { number: 42, vendor: "Shell <script>", date: "2026-11-18", total: 61.5, tax: 0, subtotal: 61.5, categoryName: "Gas / Fuel", clientName: "UTT", senderName: "Pat", sentAt: Date.UTC(2026, 10, 18, 18), sentTo: ["a@b.com"] };
  test("numbers, subject, escaping, row", () => {
    expect(receiptNo(42)).toBe("ICG-0042");
    const m = receiptMail(r);
    expect(m.subject).toBe("Receipt · $61.50 · Gas / Fuel · UTT · Pat");
    expect(m.html).not.toContain("<script>");
    expect(m.text).toContain("Total: $61.50");
    expect(sheetRow(r)).toMatchObject({ "Receipt #": "ICG-0042", Vendor: "Shell <script>", Total: 61.5, "Sent to": "a@b.com" });
  });
  test("duplicate key ignores case and punctuation", () => {
    expect(dupKey("Walmart Supercenter #12", "2026-11-18", 43.27)).toBe(dupKey("WALMART SUPERCENTER 12", "2026-11-18", 43.27));
    expect(dupKey(undefined, "2026-11-18", 1)).toBeUndefined();
  });
});

void internal;
