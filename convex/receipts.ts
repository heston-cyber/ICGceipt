import { v, ConvexError } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib/access";
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
