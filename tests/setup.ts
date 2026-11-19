import { convexTest } from "convex-test";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

export const modules = import.meta.glob("../convex/**/*.ts");

export function newT() {
  return convexTest(schema, modules);
}
export type T = ReturnType<typeof newT>;

/** A signed-in caller (Convex Auth puts "userId|sessionId" in the token's subject). */
export async function as(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) => ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3600_000 }));
  return t.withIdentity({ subject: `${userId}|${sessionId}` });
}

export async function addUser(t: T, email: string, role: "admin" | "crew", extra: Record<string, unknown> = {}) {
  return t.run((ctx) => ctx.db.insert("users", { email, role, lastSignInAt: Date.now(), ...extra }));
}
