import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

// ICGceipt data. Phase 2: who can sign in (users + invites). Phase 3: receipts (photo + what was read).
// Phase 4: clients › shoots, categories, recipients, sending (email + ICG Sheet), receipt numbers.
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

  // One receipt photo and what was read from it. "draft" until sent (Phase 4).
  receipts: defineTable({
    userId: v.id("users"),
    status: v.union(v.literal("draft"), v.literal("sent")),
    photo: v.id("_storage"),
    photoBytes: v.optional(v.number()),
    read: v.union(v.literal("reading"), v.literal("done"), v.literal("failed")),
    readError: v.optional(v.string()),
    readModel: v.optional(v.string()),
    readMs: v.optional(v.number()),
    isReceipt: v.optional(v.boolean()),
    vendor: v.optional(v.string()),
    vendorAddress: v.optional(v.string()),
    date: v.optional(v.string()),
    time: v.optional(v.string()),
    subtotal: v.optional(v.number()),
    tax: v.optional(v.number()),
    tip: v.optional(v.number()),
    total: v.optional(v.number()),
    currency: v.optional(v.string()),
    paymentMethod: v.optional(v.string()),
    cardLast4: v.optional(v.string()),
    items: v.optional(v.array(v.object({ description: v.string(), quantity: v.optional(v.number()), amount: v.optional(v.number()) }))),
    categoryHint: v.optional(v.string()),
    confidence: v.optional(v.object({ vendor: v.string(), date: v.string(), total: v.string() })),
    aiNotes: v.optional(v.string()),
    // What the reviewer should check (field → reason). Cleared field by field as they edit.
    flags: v.optional(v.record(v.string(), v.string())),
    // Fields the person changed by hand (for the accuracy log).
    edited: v.optional(v.array(v.string())),
    createdAt: v.number(),
    // Phase 4: tagging and sending. Names are copied at send time so the record never changes later.
    number: v.optional(v.number()),
    clientId: v.optional(v.id("clients")),
    shootId: v.optional(v.id("shoots")),
    categoryId: v.optional(v.id("categories")),
    clientName: v.optional(v.string()),
    shootName: v.optional(v.string()),
    categoryName: v.optional(v.string()),
    note: v.optional(v.string()),
    sentTo: v.optional(v.array(v.string())),
    sentAt: v.optional(v.number()),
    senderName: v.optional(v.string()),
    senderEmail: v.optional(v.string()),
    emailStatus: v.optional(v.union(v.literal("sending"), v.literal("sent"), v.literal("failed"))),
    emailError: v.optional(v.string()),
    sheetStatus: v.optional(v.union(v.literal("sending"), v.literal("done"), v.literal("failed"), v.literal("off"))),
    sheetError: v.optional(v.string()),
    dupKey: v.optional(v.string()), // vendor|date|total, for the duplicate warning
  })
    .index("by_user", ["userId", "createdAt"])
    .index("by_status", ["status", "createdAt"])
    .index("by_dup", ["dupKey"]),

  clients: defineTable({
    name: v.string(),
    key: v.string(), // lower-case name, for "already exists"
    archived: v.optional(v.boolean()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_key", ["key"]),

  shoots: defineTable({
    clientId: v.id("clients"),
    name: v.string(),
    key: v.string(),
    archived: v.optional(v.boolean()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_client", ["clientId", "key"]),

  categories: defineTable({
    name: v.string(),
    key: v.string(),
    order: v.number(),
    archived: v.optional(v.boolean()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
  }).index("by_key", ["key"]),

  // Shared (admin-managed, can be pre-ticked) or one person's own saved addresses.
  recipients: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    ownerId: v.optional(v.id("users")), // missing = shared
    isDefault: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerId", "email"]),

  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
});
