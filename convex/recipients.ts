import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { normEmail, requireAdmin, requireUser, validEmail } from "./lib/access";

// Who receipts can go to: a shared list (admin-managed; "default" ones come pre-ticked)
// plus each person's own saved addresses.

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireUser(ctx);
    const shared = await ctx.db.query("recipients").withIndex("by_owner", (q) => q.eq("ownerId", undefined)).collect();
    const own = await ctx.db.query("recipients").withIndex("by_owner", (q) => q.eq("ownerId", me._id)).collect();
    const sharedEmails = new Set(shared.map((r) => r.email));
    return {
      shared: shared.map((r) => ({ _id: r._id, email: r.email, name: r.name ?? "", isDefault: !!r.isDefault })),
      own: own.filter((r) => !sharedEmails.has(r.email)).map((r) => ({ _id: r._id, email: r.email, name: r.name ?? "" })),
    };
  },
});

export const addShared = mutation({
  args: { email: v.string(), name: v.optional(v.string()), isDefault: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const email = normEmail(args.email);
    if (!validEmail(email)) throw new ConvexError("Enter a valid email.");
    const same = await ctx.db.query("recipients").withIndex("by_owner", (q) => q.eq("ownerId", undefined).eq("email", email)).first();
    const name = args.name?.trim().slice(0, 60) || undefined;
    if (same) return void (await ctx.db.patch(same._id, { name: name ?? same.name, isDefault: args.isDefault ?? same.isDefault }));
    await ctx.db.insert("recipients", { email, name, isDefault: !!args.isDefault, createdAt: Date.now() });
  },
});

export const setDefault = mutation({
  args: { id: v.id("recipients"), isDefault: v.boolean() },
  handler: async (ctx, { id, isDefault }) => {
    await requireAdmin(ctx);
    const r = await ctx.db.get(id);
    if (!r || r.ownerId) throw new ConvexError("Not a shared recipient.");
    await ctx.db.patch(id, { isDefault });
  },
});

export const saveMine = mutation({
  args: { email: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await requireUser(ctx);
    const email = normEmail(args.email);
    if (!validEmail(email)) throw new ConvexError("Enter a valid email.");
    const same = await ctx.db.query("recipients").withIndex("by_owner", (q) => q.eq("ownerId", me._id).eq("email", email)).first();
    if (same) return;
    const count = (await ctx.db.query("recipients").withIndex("by_owner", (q) => q.eq("ownerId", me._id)).collect()).length;
    if (count >= 30) throw new ConvexError("That's a lot of saved addresses. Remove some first.");
    await ctx.db.insert("recipients", { email, name: args.name?.trim().slice(0, 60) || undefined, ownerId: me._id, createdAt: Date.now() });
  },
});

/** Remove one: your own, or (admin) a shared one. */
export const remove = mutation({
  args: { id: v.id("recipients") },
  handler: async (ctx, { id }) => {
    const me = await requireUser(ctx);
    const r = await ctx.db.get(id);
    if (!r) return;
    if (r.ownerId ? r.ownerId !== me._id : me.role !== "admin") throw new ConvexError("You can't remove that one.");
    await ctx.db.delete(id);
  },
});
