import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireAdmin, requireUser } from "./lib/access";

// Clients › shoots, and expense categories.
// Anyone signed in can add (on the spot, while tagging a receipt). Renaming and deleting is admin-only.
// Deleting something a receipt already uses archives it instead (hidden from the pickers, kept on old receipts).

export const DEFAULT_CATEGORIES = [
  "Crafty", "Food / Meals", "Gas / Fuel", "Parking & Tolls", "Travel & Lodging",
  "Gear Rental", "Props & Wardrobe", "Supplies", "Location", "Talent", "Other",
];

const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 60);
const keyOf = (s: string) => clean(s).toLowerCase();

/** Everything the tagging screen needs, active only (admins can ask for archived too). */
export const lists = query({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { includeArchived }) => {
    const me = await requireUser(ctx);
    const all = includeArchived && me.role === "admin";
    const keep = <T extends { archived?: boolean }>(x: T) => all || !x.archived;
    const clients = (await ctx.db.query("clients").collect()).filter(keep).sort((a, b) => a.key.localeCompare(b.key));
    const shoots = (await ctx.db.query("shoots").collect()).filter(keep).sort((a, b) => a.key.localeCompare(b.key));
    const categories = (await ctx.db.query("categories").collect()).filter(keep).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    return {
      clients: clients.map((c) => ({ _id: c._id, name: c.name, archived: !!c.archived })),
      shoots: shoots.map((s) => ({ _id: s._id, clientId: s.clientId, name: s.name, archived: !!s.archived })),
      categories: categories.map((c) => ({ _id: c._id, name: c.name, archived: !!c.archived })),
    };
  },
});

/** Puts the starter categories in, once (only when there are none at all). */
export const ensureDefaults = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    if (await ctx.db.query("categories").first()) return;
    let order = 0;
    for (const name of DEFAULT_CATEGORIES) await ctx.db.insert("categories", { name, key: keyOf(name), order: order++, createdAt: Date.now() });
  },
});

export const addClient = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const me = await requireUser(ctx);
    const n = clean(name);
    if (!n) throw new ConvexError("Enter the client's name.");
    const same = await ctx.db.query("clients").withIndex("by_key", (q) => q.eq("key", keyOf(n))).first();
    if (same) {
      if (same.archived) await ctx.db.patch(same._id, { archived: false });
      return same._id;
    }
    return await ctx.db.insert("clients", { name: n, key: keyOf(n), createdBy: me._id, createdAt: Date.now() });
  },
});

export const addShoot = mutation({
  args: { clientId: v.id("clients"), name: v.string() },
  handler: async (ctx, { clientId, name }) => {
    const me = await requireUser(ctx);
    const client = await ctx.db.get(clientId);
    if (!client) throw new ConvexError("Pick the client first.");
    const n = clean(name);
    if (!n) throw new ConvexError("Enter the shoot's name.");
    const same = await ctx.db.query("shoots").withIndex("by_client", (q) => q.eq("clientId", clientId).eq("key", keyOf(n))).first();
    if (same) {
      if (same.archived) await ctx.db.patch(same._id, { archived: false });
      return same._id;
    }
    return await ctx.db.insert("shoots", { clientId, name: n, key: keyOf(n), createdBy: me._id, createdAt: Date.now() });
  },
});

export const addCategory = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const me = await requireUser(ctx);
    const n = clean(name);
    if (!n) throw new ConvexError("Enter a category name.");
    const same = await ctx.db.query("categories").withIndex("by_key", (q) => q.eq("key", keyOf(n))).first();
    if (same) {
      if (same.archived) await ctx.db.patch(same._id, { archived: false });
      return same._id;
    }
    const last = (await ctx.db.query("categories").collect()).reduce((m, c) => Math.max(m, c.order), -1);
    return await ctx.db.insert("categories", { name: n, key: keyOf(n), order: last + 1, createdBy: me._id, createdAt: Date.now() });
  },
});

type Kind = "clients" | "shoots" | "categories";
const kind = v.union(v.literal("clients"), v.literal("shoots"), v.literal("categories"));

/** Admin: rename. Old sent receipts keep the name they were sent with. */
export const rename = mutation({
  args: { kind, id: v.string(), name: v.string() },
  handler: async (ctx, { kind, id, name }) => {
    await requireAdmin(ctx);
    const n = clean(name);
    if (!n) throw new ConvexError("Enter a name.");
    const doc = await getDoc(ctx, kind, id);
    const clash = await findSame(ctx, kind, n, doc);
    if (clash && clash !== doc._id) throw new ConvexError(`There's already one called "${n}".`);
    await ctx.db.patch(doc._id, { name: n, key: keyOf(n) });
  },
});

/** Admin: delete. If any receipt uses it (or, for a client, any shoot does), it's archived instead. */
export const remove = mutation({
  args: { kind, id: v.string() },
  handler: async (ctx, { kind, id }): Promise<"deleted" | "archived"> => {
    await requireAdmin(ctx);
    const doc = await getDoc(ctx, kind, id);
    const field = kind === "clients" ? "clientId" : kind === "shoots" ? "shootId" : "categoryId";
    const used = (await ctx.db.query("receipts").collect()).some((r) => (r as Record<string, unknown>)[field] === doc._id);
    const hasShoots = kind === "clients" && !!(await ctx.db.query("shoots").withIndex("by_client", (q) => q.eq("clientId", doc._id as Id<"clients">)).first());
    if (used || hasShoots) {
      await ctx.db.patch(doc._id, { archived: true });
      if (kind === "clients")
        for (const s of await ctx.db.query("shoots").withIndex("by_client", (q) => q.eq("clientId", doc._id as Id<"clients">)).collect())
          await ctx.db.patch(s._id, { archived: true });
      return "archived";
    }
    await ctx.db.delete(doc._id);
    return "deleted";
  },
});

export const restore = mutation({
  args: { kind, id: v.string() },
  handler: async (ctx, { kind, id }) => {
    await requireAdmin(ctx);
    const doc = await getDoc(ctx, kind, id);
    await ctx.db.patch(doc._id, { archived: false });
  },
});

async function getDoc(ctx: MutationCtx, kind: Kind, id: string) {
  const nid = ctx.db.normalizeId(kind, id);
  const doc = nid ? await ctx.db.get(nid) : null;
  if (!doc) throw new ConvexError("Not found.");
  return doc;
}

async function findSame(ctx: MutationCtx, kind: Kind, n: string, doc: { _id: string; clientId?: Id<"clients"> }) {
  const k = keyOf(n);
  if (kind === "clients") return (await ctx.db.query("clients").withIndex("by_key", (q) => q.eq("key", k)).first())?._id;
  if (kind === "categories") return (await ctx.db.query("categories").withIndex("by_key", (q) => q.eq("key", k)).first())?._id;
  return (await ctx.db.query("shoots").withIndex("by_client", (q) => q.eq("clientId", doc.clientId!).eq("key", k)).first())?._id;
}
