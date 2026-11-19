import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

// ICGceipt data. Phase 2: who can sign in (users + invites).
// Later phases add shoots, categories, recipients and receipts.
export default defineSchema({
  ...authTables,

  // Convex Auth's users table, plus ICGceipt's own fields.
  users: defineTable({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    image: v.optional(v.string()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // "admin" manages shoots, categories and crew; "crew" snaps and sends.
    role: v.optional(v.union(v.literal("admin"), v.literal("crew"))),
    // A removed crew member is kept (their receipts stay attributed) but can't sign in.
    disabled: v.optional(v.boolean()),
    lastSignInAt: v.optional(v.number()),
  }).index("email", ["email"]),

  // Who may sign in. An admin adds an email; the person signs in with an emailed code.
  invites: defineTable({
    email: v.string(), // lower-case
    name: v.optional(v.string()),
    role: v.union(v.literal("admin"), v.literal("crew")),
    invitedBy: v.optional(v.id("users")),
    createdAt: v.number(),
    acceptedAt: v.optional(v.number()),
  }).index("by_email", ["email"]),
});
