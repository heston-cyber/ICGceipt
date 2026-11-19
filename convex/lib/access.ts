import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

export const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
export const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** Bootstrap admins: ADMIN_EMAILS (comma-separated) in the Convex dashboard. They never need an invite. */
export const adminEmails = () =>
  (process.env.ADMIN_EMAILS ?? "").split(/[,;\s]+/).map(normEmail).filter(Boolean);

/** The signed-in, active user, or null. */
export async function currentUser(ctx: QueryCtx): Promise<Doc<"users"> | null> {
  const id = await getAuthUserId(ctx);
  if (!id) return null;
  const u = await ctx.db.get(id);
  if (!u || u.disabled) return null;
  return u;
}

export async function requireUser(ctx: QueryCtx): Promise<Doc<"users">> {
  const u = await currentUser(ctx);
  if (!u) throw new ConvexError("Please sign in.");
  return u;
}

export async function requireAdmin(ctx: QueryCtx): Promise<Doc<"users">> {
  const u = await requireUser(ctx);
  if (u.role !== "admin") throw new ConvexError("Only an admin can do that.");
  return u;
}
