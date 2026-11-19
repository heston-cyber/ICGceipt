import { v, ConvexError } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser, normEmail, validEmail } from "./lib/access";
import { fromOnBehalf, sendEmail } from "./lib/email";
import { dupKey, photoFileName, receiptMail, receiptNo, sheetRow, type SentReceipt } from "./lib/receiptMail";
import { RECEIPT_PROMPT, RECEIPT_TOOL, checkReading, needsSecondLook, normalizeReading, type Confidence, type Reading } from "./lib/reading";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // the phone shrinks photos to ~0.3–1 MB first
export const FAST_MODEL = () => (process.env.RECEIPT_MODEL ?? "").trim() || "claude-haiku-5-5";
export const STRONG_MODEL = () => (process.env.RECEIPT_MODEL_STRONG ?? "").trim() || "claude-sonnet-5-5";

/** The receipt, if the caller owns it or is an admin. */
async function loadFor(ctx: QueryCtx, id: Id<"receipts">) {
  const me = await requireUser(ctx);
  const r = await ctx.db.get(id);
  if (!r || (r.userId !== me._id && me.role !== "admin")) throw new ConvexError("Receipt not found.");
  return { me, r };
}

export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/** A new draft from an uploaded photo; reading starts straight away.
 *  A bad file is deleted and reported as { error } (throwing would roll the delete back). */
export const create = mutation({
  args: { photo: v.id("_storage") },
  handler: async (ctx, { photo }): Promise<{ id: Id<"receipts"> } | { error: string }> => {
    const me = await requireUser(ctx);
    const meta = await ctx.db.system.get(photo);
    if (!meta) return { error: "The photo didn't upload. Try again." };
    if (!(meta.contentType ?? "").startsWith("image/") || meta.size > MAX_PHOTO_BYTES) {
      await ctx.storage.delete(photo);
      return { error: "That file isn't a photo the app can read." };
    }
    const id = await ctx.db.insert("receipts", {
      userId: me._id,
      status: "draft",
      photo,
      photoBytes: meta.size,
      read: "reading",
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.receipts.readPhoto, { id });
    return { id };
  },
});

/** One receipt with its photo link. */
export const get = query({
  args: { id: v.id("receipts") },
  handler: async (ctx, { id }) => {
    const { me, r } = await loadFor(ctx, id).catch(() => ({ me: null, r: null }));
    if (!r || !me) return null;
    return { ...r, photoUrl: await ctx.storage.getUrl(r.photo), mine: r.userId === me._id };
  },
});

/** My unsent drafts, newest first. */
export const myDrafts = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireUser(ctx);
    const rows = await ctx.db
      .query("receipts")
      .withIndex("by_user", (q) => q.eq("userId", me._id))
      .order("desc")
      .take(30);
    return rows
      .filter((r) => r.status === "draft")
      .map((r) => ({ _id: r._id, vendor: r.vendor ?? null, total: r.total ?? null, date: r.date ?? null, read: r.read, createdAt: r.createdAt, flagged: Object.keys(r.flags ?? {}).length }));
  },
});

const nullable = <T extends ReturnType<typeof v.string>>(t: T) => v.optional(v.union(v.null(), t));
const nnum = v.optional(v.union(v.null(), v.number()));

/** Fix what was read. Editing a field clears its "check this" flag; the math checks re-run. */
export const update = mutation({
  args: {
    id: v.id("receipts"),
    vendor: nullable(v.string()),
    vendorAddress: nullable(v.string()),
    date: nullable(v.string()),
    time: nullable(v.string()),
    subtotal: nnum,
    tax: nnum,
    tip: nnum,
    total: nnum,
    paymentMethod: nullable(v.string()),
    cardLast4: nullable(v.string()),
    items: v.optional(v.array(v.object({ description: v.string(), quantity: v.optional(v.number()), amount: v.optional(v.number()) }))),
  },
  handler: async (ctx, { id, ...fields }) => {
    const { me, r } = await loadFor(ctx, id);
    if (r.userId !== me._id) throw new ConvexError("Only the person who snapped it can edit it.");
    if (r.status !== "draft") throw new ConvexError("This receipt was already sent.");
    if (fields.date && !/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) throw new ConvexError("Use a full date.");
    if (fields.cardLast4 && !/^\d{4}$/.test(fields.cardLast4)) throw new ConvexError("Card: just the last 4 digits.");
    for (const k of ["subtotal", "tax", "tip", "total"] as const) {
      const n = fields[k];
      if (typeof n === "number" && (!Number.isFinite(n) || n < 0 || n > 1_000_000)) throw new ConvexError(`Check the ${k}.`);
    }
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    for (const [k, val] of Object.entries(fields)) {
      if (val === undefined) continue;
      const clean = typeof val === "string" ? val.trim().slice(0, 200) || undefined : typeof val === "number" ? Math.round(val * 100) / 100 : val ?? undefined;
      patch[k] = clean;
      changed.push(k);
    }
    if (!changed.length) return;
    const confidence = { ...(r.confidence ?? { vendor: "high", date: "high", total: "high" }) };
    for (const k of ["vendor", "date", "total"] as const) if (changed.includes(k)) confidence[k] = "high";
    patch.confidence = confidence;
    const next = { ...r, ...patch } as Doc<"receipts">;
    patch.flags = checkReading(asReading(next));
    patch.edited = [...new Set([...(r.edited ?? []), ...changed])];
    await ctx.db.patch(id, patch);
  },
});

/** Throw away a draft and its photo. */
export const discard = mutation({
  args: { id: v.id("receipts") },
  handler: async (ctx, { id }) => {
    const { me, r } = await loadFor(ctx, id);
    if (r.userId !== me._id) throw new ConvexError("Only the person who snapped it can discard it.");
    if (r.status !== "draft") throw new ConvexError("Sent receipts can't be discarded.");
    await ctx.storage.delete(r.photo);
    await ctx.db.delete(id);
  },
});

/** Read it again (after a failure, or if the first read was off). */
export const reread = mutation({
  args: { id: v.id("receipts") },
  handler: async (ctx, { id }) => {
    const { me, r } = await loadFor(ctx, id);
    if (r.userId !== me._id || r.status !== "draft") throw new ConvexError("Can't re-read this one.");
    if (r.read === "reading") return;
    await ctx.db.patch(id, { read: "reading", readError: undefined });
    await ctx.scheduler.runAfter(0, internal.receipts.readPhoto, { id, strong: true });
  },
});

function asReading(r: Doc<"receipts">): Reading {
  const c = r.confidence ?? { vendor: "high", date: "high", total: "high" };
  return {
    isReceipt: r.isReceipt !== false,
    vendor: r.vendor, vendorAddress: r.vendorAddress, date: r.date, time: r.time,
    subtotal: r.subtotal, tax: r.tax, tip: r.tip, total: r.total, currency: r.currency,
    paymentMethod: r.paymentMethod, cardLast4: r.cardLast4, items: r.items ?? [],
    confidence: { vendor: c.vendor as Confidence, date: c.date as Confidence, total: c.total as Confidence },
  };
}

// ── Reading (server side) ────────────────────────────────────────────────────────────────

export const forReading = internalQuery({
  args: { id: v.id("receipts") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const saveReading = internalMutation({
  args: { id: v.id("receipts"), reading: v.any(), model: v.string(), ms: v.number() },
  handler: async (ctx, { id, reading, model, ms }) => {
    const r = await ctx.db.get(id);
    if (!r || r.status !== "draft") return;
    const x = reading as Reading;
    await ctx.db.patch(id, {
      read: "done",
      readError: undefined,
      readModel: model,
      readMs: ms,
      isReceipt: x.isReceipt,
      vendor: x.vendor, vendorAddress: x.vendorAddress, date: x.date, time: x.time,
      subtotal: x.subtotal, tax: x.tax, tip: x.tip, total: x.total, currency: x.currency,
      paymentMethod: x.paymentMethod, cardLast4: x.cardLast4, items: x.items,
      categoryHint: x.categoryHint, aiNotes: x.notes, confidence: x.confidence,
      flags: checkReading(x),
      edited: [],
    });
  },
});

export const failReading = internalMutation({
  args: { id: v.id("receipts"), error: v.string() },
  handler: async (ctx, { id, error }) => {
    const r = await ctx.db.get(id);
    if (r && r.status === "draft") await ctx.db.patch(id, { read: "failed", readError: error.slice(0, 300) });
  },
});

export const readPhoto = internalAction({
  args: { id: v.id("receipts"), strong: v.optional(v.boolean()) },
  handler: async (ctx, { id, strong }) => {
    const started = Date.now();
    try {
      const r = await ctx.runQuery(internal.receipts.forReading, { id });
      if (!r) return;
      const blob = await ctx.storage.get(r.photo);
      if (!blob) throw new Error("The photo is missing.");
      const mediaType = blob.type && /^image\/(jpeg|png|webp|gif)$/.test(blob.type) ? blob.type : "image/jpeg";
      const b64 = toBase64(new Uint8Array(await blob.arrayBuffer()));

      let model = strong ? STRONG_MODEL() : FAST_MODEL();
      let reading: Reading;
      try {
        reading = await askClaude(model, b64, mediaType);
      } catch (e) {
        if (model === STRONG_MODEL()) throw e;
        console.log(`fast read failed, trying ${STRONG_MODEL()}: ${String(e).slice(0, 120)}`);
        model = STRONG_MODEL();
        reading = await askClaude(model, b64, mediaType);
      }
      if (model !== STRONG_MODEL() && needsSecondLook(reading, checkReading(reading))) {
        try {
          const second = await askClaude(STRONG_MODEL(), b64, mediaType);
          reading = second;
          model = STRONG_MODEL();
        } catch (e) {
          console.log(`second look failed, keeping the first read: ${String(e).slice(0, 120)}`);
        }
      }
      await ctx.runMutation(internal.receipts.saveReading, { id, reading, model, ms: Date.now() - started });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      console.error(`read failed: ${msg.slice(0, 300)}`);
      await ctx.runMutation(internal.receipts.failReading, {
        id,
        error: /ANTHROPIC_API_KEY/.test(msg) ? "Receipt reading isn't set up yet." : "Couldn't read it this time.",
      });
    }
  },
});

async function askClaude(model: string, b64: string, mediaType: string): Promise<Reading> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("No ANTHROPIC_API_KEY in Convex.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      tools: [RECEIPT_TOOL],
      tool_choice: { type: "tool", name: RECEIPT_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: RECEIPT_PROMPT },
          ],
        },
      ],
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>; error?: { message?: string } };
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(j.error?.message ?? "").slice(0, 160)}`);
  const use = j.content?.find((c) => c.type === "tool_use" && c.name === RECEIPT_TOOL.name);
  if (!use?.input) throw new Error("Claude didn't return the receipt fields.");
  return normalizeReading(use.input);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ── Tag & send (Phase 4) ─────────────────────────────────────────────────────────────────

/** Tags the receipt and sends it: email (on the sender's behalf, photo attached) + a row in the ICG Sheet.
 *  If the same vendor/date/total was sent before, returns { duplicate } unless confirmDuplicate is set. */
export const send = mutation({
  args: {
    id: v.id("receipts"),
    clientId: v.id("clients"),
    shootId: v.optional(v.id("shoots")),
    categoryId: v.id("categories"),
    note: v.optional(v.string()),
    to: v.array(v.string()),
    confirmDuplicate: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ number: number } | { duplicate: { number: string; by: string; at: number } }> => {
    const { me, r } = await loadFor(ctx, args.id);
    if (r.userId !== me._id) throw new ConvexError("Only the person who snapped it can send it.");
    if (r.status !== "draft") throw new ConvexError("This receipt was already sent.");
    if (r.read === "reading") throw new ConvexError("Still reading the receipt. One moment.");
    const missing = [!r.vendor && "vendor", !r.date && "date", r.total === undefined && "total"].filter(Boolean);
    if (missing.length) throw new ConvexError(`Fill in the ${missing.join(", ")} first.`);
    if (!me.name) throw new ConvexError("Add your name first (Me tab).");

    const client = await ctx.db.get(args.clientId);
    if (!client || client.archived) throw new ConvexError("Pick a client.");
    const shoot = args.shootId ? await ctx.db.get(args.shootId) : null;
    if (args.shootId && (!shoot || shoot.archived || shoot.clientId !== client._id)) throw new ConvexError("That shoot isn't under this client.");
    const category = await ctx.db.get(args.categoryId);
    if (!category || category.archived) throw new ConvexError("Pick a category.");

    const to = [...new Set(args.to.map(normEmail))];
    if (!to.length) throw new ConvexError("Add at least one email to send it to.");
    if (to.length > 10) throw new ConvexError("Ten recipients at most.");
    const bad = to.find((e) => !validEmail(e));
    if (bad) throw new ConvexError(`"${bad}" isn't a valid email.`);

    const key = dupKey(r.vendor, r.date, r.total);
    if (key && !args.confirmDuplicate) {
      const prior = (await ctx.db.query("receipts").withIndex("by_dup", (q) => q.eq("dupKey", key)).collect()).find((x) => x.status === "sent");
      if (prior) {
        const by = prior.senderName ?? "someone";
        return { duplicate: { number: receiptNo(prior.number ?? 0), by, at: prior.sentAt ?? prior.createdAt } };
      }
    }

    const counter = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "receipt")).first();
    const number = (counter?.value ?? 0) + 1;
    if (counter) await ctx.db.patch(counter._id, { value: number });
    else await ctx.db.insert("counters", { name: "receipt", value: number });

    await ctx.db.patch(r._id, {
      status: "sent",
      number,
      clientId: client._id, clientName: client.name,
      shootId: shoot?._id, shootName: shoot?.name,
      categoryId: category._id, categoryName: category.name,
      note: args.note?.trim().slice(0, 500) || undefined,
      sentTo: to, sentAt: Date.now(),
      senderName: me.name, senderEmail: me.email,
      emailStatus: "sending", sheetStatus: "sending",
      dupKey: key,
    });
    await ctx.scheduler.runAfter(0, internal.receipts.deliver, { id: r._id });
    return { number };
  },
});

/** Try the email and/or the Sheet again after a failure. */
export const retryDelivery = mutation({
  args: { id: v.id("receipts") },
  handler: async (ctx, { id }) => {
    const { me, r } = await loadFor(ctx, id);
    if (r.userId !== me._id && me.role !== "admin") throw new ConvexError("Not yours to resend.");
    if (r.status !== "sent") throw new ConvexError("Send it first.");
    const email = r.emailStatus === "failed", sheet = r.sheetStatus === "failed";
    if (!email && !sheet) return;
    await ctx.db.patch(id, { ...(email ? { emailStatus: "sending" as const, emailError: undefined } : {}), ...(sheet ? { sheetStatus: "sending" as const, sheetError: undefined } : {}) });
    await ctx.scheduler.runAfter(0, internal.receipts.deliver, { id, email, sheet });
  },
});

export const setDelivery = internalMutation({
  args: {
    id: v.id("receipts"),
    emailStatus: v.optional(v.union(v.literal("sent"), v.literal("failed"))),
    emailError: v.optional(v.string()),
    sheetStatus: v.optional(v.union(v.literal("done"), v.literal("failed"), v.literal("off"))),
    sheetError: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...patch }) => {
    await ctx.db.patch(id, patch);
  },
});

export const deliver = internalAction({
  args: { id: v.id("receipts"), email: v.optional(v.boolean()), sheet: v.optional(v.boolean()) },
  handler: async (ctx, { id, email = true, sheet = true }) => {
    const r = await ctx.runQuery(internal.receipts.forReading, { id });
    if (!r || r.status !== "sent" || !r.number) return;
    const sent = r as unknown as SentReceipt;
    const blob = await ctx.storage.get(r.photo);
    const photoName = photoFileName(sent);

    if (email) {
      try {
        if (!blob) throw new Error("The photo is missing.");
        const m = receiptMail(sent);
        const to = r.sentTo ?? [];
        const cc = r.senderEmail && !to.includes(r.senderEmail) ? [r.senderEmail] : [];
        await sendEmail({
          from: fromOnBehalf(r.senderName ?? ""),
          to, cc, replyTo: r.senderEmail,
          subject: m.subject, text: m.text, html: m.html, tag: "receipt",
          attachments: [{ filename: photoName, content: toBase64(new Uint8Array(await blob.arrayBuffer())) }],
        });
        await ctx.runMutation(internal.receipts.setDelivery, { id, emailStatus: "sent" });
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 200);
        console.error(`receipt email failed: ${msg}`);
        await ctx.runMutation(internal.receipts.setDelivery, { id, emailStatus: "failed", emailError: msg });
      }
    }

    if (sheet) {
      const url = (process.env.ICG_SHEET_URL ?? "").trim();
      if (!url) {
        await ctx.runMutation(internal.receipts.setDelivery, { id, sheetStatus: "off" });
        return;
      }
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "text/plain;charset=utf-8" }, // Apps Script reads e.postData.contents
          body: JSON.stringify({
            secret: process.env.ICG_SHEET_SECRET ?? "",
            row: sheetRow(sent),
            photoUrl: await ctx.storage.getUrl(r.photo),
            photoName,
          }),
          redirect: "follow",
        });
        const text = await res.text();
        let ok = false, err = "";
        try { const j = JSON.parse(text) as { ok?: boolean; error?: string }; ok = !!j.ok; err = j.error ?? ""; }
        catch { err = /^\s*</.test(text) ? "Google asked for a sign-in: the Sheet's web app needs “Who has access: Anyone”" : `Unexpected reply (${res.status})`; }
        if (!ok) throw new Error(err || `Sheet said no (${res.status})`);
        await ctx.runMutation(internal.receipts.setDelivery, { id, sheetStatus: "done" });
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 200);
        console.error(`sheet failed: ${msg}`);
        await ctx.runMutation(internal.receipts.setDelivery, { id, sheetStatus: "failed", sheetError: msg });
      }
    }
  },
});
