import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { decideSignIn, NOT_INVITED, REMOVED } from "../convex/auth";
import { fromOnBehalf, signInMail } from "../convex/lib/email";
import { addUser, as, newT } from "./setup";

beforeEach(() => {
  process.env.ADMIN_EMAILS = "heston@icgadv.com";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "x" }), { status: 200 })));
  process.env.RESEND_API_KEY = "test";
});
afterEach(() => vi.unstubAllGlobals());

const msg = (e: unknown) => String((e as { data?: unknown })?.data ?? (e as Error)?.message ?? e);

describe("T2.1 who can sign in (checked before any code is emailed)", () => {
  test("a stranger is refused and no user is created", async () => {
    const t = newT();
    const err = await t.run((ctx) => decideSignIn(ctx, { email: "rando@gmail.com", existingUserId: null, verified: false })).catch((e) => e);
    expect(msg(err)).toContain(NOT_INVITED);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(0);
  });

  test("the ADMIN_EMAILS person gets in as admin with no invite (any letter case)", async () => {
    const t = newT();
    const id = await t.run((ctx) => decideSignIn(ctx, { email: " Heston@ICGadv.com ", existingUserId: null, verified: true }));
    const u = await t.run((ctx) => ctx.db.get(id));
    expect(u?.role).toBe("admin");
    expect(u?.email).toBe("heston@icgadv.com");
  });

  test("an invited crew member gets in as crew, with the invite's name; the invite is marked used", async () => {
    const t = newT();
    await t.run((ctx) => ctx.db.insert("invites", { email: "pat@icgadv.com", name: "Pat", role: "crew", createdAt: 1 }));
    const id = await t.run((ctx) => decideSignIn(ctx, { email: "pat@icgadv.com", existingUserId: null, verified: true }));
    const u = await t.run((ctx) => ctx.db.get(id));
    expect(u).toMatchObject({ role: "crew", name: "Pat" });
    const inv = await t.run((ctx) => ctx.db.query("invites").first());
    expect(inv?.acceptedAt).toBeTypeOf("number");
  });

  test("a removed person can't even get a code", async () => {
    const t = newT();
    await t.run((ctx) => ctx.db.insert("invites", { email: "pat@icgadv.com", role: "crew", createdAt: 1 }));
    const id = await addUser(t, "pat@icgadv.com", "crew", { disabled: true });
    const err = await t.run((ctx) => decideSignIn(ctx, { email: "pat@icgadv.com", existingUserId: id, verified: false })).catch((e) => e);
    expect(msg(err)).toContain(REMOVED);
  });

  test("someone whose invite was cancelled is refused", async () => {
    const t = newT();
    const id = await addUser(t, "pat@icgadv.com", "crew");
    const err = await t.run((ctx) => decideSignIn(ctx, { email: "pat@icgadv.com", existingUserId: id, verified: false })).catch((e) => e);
    expect(msg(err)).toContain(NOT_INVITED);
  });
});

describe("T2.2 crew management is admin-only", () => {
  test("signed-out: me is null; crew list refused", async () => {
    const t = newT();
    expect(await t.query(api.users.me, {})).toBeNull();
    await expect(t.query(api.users.crew, {})).rejects.toThrow();
  });

  test("crew can't invite or see the crew list", async () => {
    const t = newT();
    const crew = await as(t, await addUser(t, "pat@icgadv.com", "crew"));
    await expect(crew.mutation(api.users.invite, { email: "x@y.com", role: "crew" })).rejects.toThrow(/admin/);
    await expect(crew.query(api.users.crew, {})).rejects.toThrow(/admin/);
  });

  test("admin invites (email cleaned up), the invite shows as pending, and an invite email goes out", async () => {
    vi.useFakeTimers();
    const t = newT();
    const admin = await as(t, await addUser(t, "heston@icgadv.com", "admin", { name: "Heston" }));
    await admin.mutation(api.users.invite, { email: "  Pat@ICGadv.com", name: "Pat", role: "crew" });
    const list = await admin.query(api.users.crew, {});
    expect(list.pending.map((p) => p.email)).toEqual(["pat@icgadv.com"]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sent = (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(sent.length).toBe(1);
    expect(JSON.parse(String(sent[0][1].body)).to).toEqual(["pat@icgadv.com"]);
    vi.useRealTimers();
  });

  test("bad emails are refused", async () => {
    const t = newT();
    const admin = await as(t, await addUser(t, "heston@icgadv.com", "admin"));
    await expect(admin.mutation(api.users.invite, { email: "not-an-email", role: "crew" })).rejects.toThrow(/valid email/);
  });
});

describe("T2.3 roles and removal keep at least one admin", () => {
  test("the last admin can't be made crew; can't remove yourself; the ADMIN_EMAILS admin is locked", async () => {
    const t = newT();
    process.env.ADMIN_EMAILS = "";
    const aId = await addUser(t, "a@icgadv.com", "admin");
    const admin = await as(t, aId);
    await expect(admin.mutation(api.users.setRole, { userId: aId, role: "crew" })).rejects.toThrow(/at least one admin/);
    await expect(admin.mutation(api.users.remove, { userId: aId })).rejects.toThrow(/yourself/);
    process.env.ADMIN_EMAILS = "boss@icgadv.com";
    const boss = await addUser(t, "boss@icgadv.com", "admin");
    await expect(admin.mutation(api.users.remove, { userId: boss })).rejects.toThrow(/can't be removed/);
  });

  test("removing crew signs them out everywhere and they stop being 'me'", async () => {
    const t = newT();
    const admin = await as(t, await addUser(t, "heston@icgadv.com", "admin"));
    await t.run((ctx) => ctx.db.insert("invites", { email: "pat@icgadv.com", role: "crew", createdAt: 1 }));
    const pId = await addUser(t, "pat@icgadv.com", "crew");
    const pat = await as(t, pId);
    expect((await pat.query(api.users.me, {}))?.email).toBe("pat@icgadv.com");
    await admin.mutation(api.users.remove, { userId: pId });
    expect(await pat.query(api.users.me, {})).toBeNull();
    const sessions = await t.run((ctx) => ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", pId)).collect());
    expect(sessions).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("invites").collect())).toHaveLength(0);
  });

  test("promote crew to admin", async () => {
    const t = newT();
    const admin = await as(t, await addUser(t, "heston@icgadv.com", "admin"));
    const pId = await addUser(t, "pat@icgadv.com", "crew");
    await admin.mutation(api.users.setRole, { userId: pId, role: "admin" });
    expect((await t.run((ctx) => ctx.db.get(pId)))?.role).toBe("admin");
  });
});

describe("T2.4 emails", () => {
  test("sign-in email carries the code and a one-tap link with the email", () => {
    process.env.SITE_URL = "https://icgceipts.hillsbuilds.com";
    const m = signInMail("123456", "pat@icgadv.com", 15);
    expect(m.subject).toContain("123456");
    expect(m.text).toContain("https://icgceipts.hillsbuilds.com/?signin=123456&email=pat%40icgadv.com");
  });
  test("receipts go out in the sender's name on the verified address (no header injection)", () => {
    process.env.EMAIL_FROM = "ICGceipt <receipts@hillsbuilds.com>";
    expect(fromOnBehalf("Heston Hill")).toBe('"Heston Hill via ICGceipt" <receipts@hillsbuilds.com>');
    expect(fromOnBehalf('Evil" <x@y.com>\r\nBcc: z')).not.toMatch(/[\r\n<>]x@y/);
  });
});
