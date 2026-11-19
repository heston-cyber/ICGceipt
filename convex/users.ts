import { v, ConvexError } from "convex/values";
import { internalAction, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { adminEmails, currentUser, normEmail, requireAdmin, requireUser, validEmail } from "./lib/access";
import { SITE, esc, sendEmail } from "./lib/email";

const role = v.union(v.literal("admin"), v.literal("crew"));

/** The signed-in person, or null. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const u = await currentUser(ctx);
    if (!u) return null;
    return { _id: u._id, email: u.email ?? "", name: u.name ?? "", role: u.role ?? "crew" };
  },
});

export const setMyName = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const u = await requireUser(ctx);
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new ConvexError("Enter your name.");
    await ctx.db.patch(u._id, { name: clean });
  },
});

/** Admin: everyone who can sign in, plus invites not used yet. */
export const crew = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireAdmin(ctx);
    const users = (await ctx.db.query("users").collect()).filter((u) => !u.disabled && u.email);
    const invites = await ctx.db.query("invites").collect();
    const boot = adminEmails();
    const people = users.map((u) => ({
      kind: "user" as const,
      _id: u._id,
      email: u.email!,
      name: u.name ?? "",
      role: u.role ?? "crew",
      lastSignInAt: u.lastSignInAt ?? null,
      isMe: u._id === me._id,
      locked: boot.includes(normEmail(u.email)), // admin by ADMIN_EMAILS; can't be changed in the app
    }));
    const signedUp = new Set(users.filter((u) => u.lastSignInAt).map((u) => normEmail(u.email)));
    const pending = invites
      .filter((i) => !signedUp.has(i.email))
      .map((i) => ({ kind: "invite" as const, _id: i._id, email: i.email, name: i.name ?? "", role: i.role, createdAt: i.createdAt }));
    return {
      people: people.filter((p) => signedUp.has(normEmail(p.email)) || p.locked),
      pending,
    };
  },
});

export const invite = mutation({
  args: { email: v.string(), name: v.optional(v.string()), role },
  handler: async (ctx, args) => {
    const me = await requireAdmin(ctx);
    const email = normEmail(args.email);
    if (!validEmail(email)) throw new ConvexError("Enter a valid email.");
    const name = args.name?.trim().slice(0, 60) || undefined;
    const existing = await ctx.db.query("invites").withIndex("by_email", (q) => q.eq("email", email)).first();
    if (existing) await ctx.db.patch(existing._id, { role: args.role, ...(name ? { name } : {}) });
    else await ctx.db.insert("invites", { email, role: args.role, name, invitedBy: me._id, createdAt: Date.now() });
    // Someone removed earlier comes back.
    const prior = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).first();
    if (prior) await ctx.db.patch(prior._id, { disabled: false, role: args.role, ...(name ? { name } : {}) });
    await ctx.scheduler.runAfter(0, internal.users.sendInviteEmail, { email, inviter: me.name || me.email || "Your admin" });
  },
});

export const sendInviteEmail = internalAction({
  args: { email: v.string(), inviter: v.string() },
  handler: async (_ctx, { email, inviter }) => {
    const site = SITE();
    const text =
      `${inviter} added you to ICGceipt, ICG's receipt app.\n\n` +
      `Open ${site} on your iPhone in Safari, tap Share → Add to Home Screen, then sign in with this email address (${email}). ` +
      `We'll email you a 6-digit code each time you sign in.`;
    const html = `<!doctype html><html><body style="margin:0;padding:28px 18px;background:#FFFDE9;color:#201F1F;font:16px/1.5 -apple-system,Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto">
<p style="margin:0 0 18px;font-weight:800;letter-spacing:-.02em;font-size:22px">ICG<span style="color:#EF2600">ceipt</span></p>
<p style="margin:0 0 14px">${esc(inviter)} added you to <b>ICGceipt</b>, ICG's receipt app. Snap a receipt, tag the shoot, done.</p>
<p style="margin:0 0 22px"><a href="${esc(site)}" style="display:inline-block;background:#EF2600;color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:999px">Open ICGceipt</a></p>
<p style="margin:0 0 8px"><b>On iPhone:</b> open it in Safari, tap <b>Share → Add to Home Screen</b>.</p>
<p style="margin:0;color:#6b6866;font-size:14px">Sign in with ${esc(email)}. We'll email you a 6-digit code.</p>
</div></body></html>`;
    await sendEmail({ to: [email], subject: `${inviter} added you to ICGceipt`, text, html, tag: "invite" });
  },
});

async function countAdmins(ctx: MutationCtx) {
  return (await ctx.db.query("users").collect()).filter((u) => !u.disabled && u.role === "admin").length;
}

export const setRole = mutation({
  args: { userId: v.id("users"), role },
  handler: async (ctx, { userId, role }) => {
    await requireAdmin(ctx);
    const u = await ctx.db.get(userId);
    if (!u || u.disabled) throw new ConvexError("Not found.");
    if (adminEmails().includes(normEmail(u.email))) throw new ConvexError("This admin is set in the app's settings and can't be changed here.");
    if (u.role === "admin" && role === "crew" && (await countAdmins(ctx)) <= 1) throw new ConvexError("There has to be at least one admin.");
    await ctx.db.patch(userId, { role });
    const inv = await ctx.db.query("invites").withIndex("by_email", (q) => q.eq("email", normEmail(u.email))).first();
    if (inv) await ctx.db.patch(inv._id, { role });
  },
});

/** Removes a crew member: they're signed out everywhere and can't sign in. Their receipts stay theirs. */
export const remove = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await requireAdmin(ctx);
    if (userId === me._id) throw new ConvexError("You can't remove yourself.");
    const u = await ctx.db.get(userId);
    if (!u) throw new ConvexError("Not found.");
    if (adminEmails().includes(normEmail(u.email))) throw new ConvexError("This admin is set in the app's settings and can't be removed here.");
    await ctx.db.patch(userId, { disabled: true });
    const inv = await ctx.db.query("invites").withIndex("by_email", (q) => q.eq("email", normEmail(u.email))).first();
    if (inv) await ctx.db.delete(inv._id);
    await endSessions(ctx, userId);
  },
});

export const cancelInvite = mutation({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    await requireAdmin(ctx);
    const inv = await ctx.db.get(inviteId);
    if (inv) await ctx.db.delete(inviteId);
  },
});

async function endSessions(ctx: MutationCtx, userId: Id<"users">) {
  for (const s of await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).collect()) {
    for (const t of await ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", s._id)).collect())
      await ctx.db.delete(t._id);
    await ctx.db.delete(s._id);
  }
}
