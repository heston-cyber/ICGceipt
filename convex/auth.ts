import { convexAuth } from "@convex-dev/auth/server";
import { Email } from "@convex-dev/auth/providers/Email";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { adminEmails, normEmail } from "./lib/access";
import { sendEmail, signInMail, sixDigits } from "./lib/email";

const CODE_MINUTES = 15;
export const NOT_INVITED = "This email isn't on the ICGceipt crew list yet. Ask your admin to add you.";
export const REMOVED = "This account was removed from ICGceipt. Ask your admin if that's a mistake.";

// Sign-in: an emailed 6-digit code. The same email carries a one-tap link for Safari; the home-screen app
// (which keeps its own storage on iPhone) uses the code. The code only works together with the email it was sent to.
const EmailCode = Email({
  id: "email",
  maxAge: CODE_MINUTES * 60,
  apiKey: "unused", // sent through Resend ourselves
  async generateVerificationToken() {
    return sixDigits();
  },
  async sendVerificationRequest({ identifier, token }) {
    const m = signInMail(token, identifier, CODE_MINUTES);
    try {
      await sendEmail({ to: [identifier], subject: m.subject, text: m.text, html: m.html, tag: "signin" });
    } catch (e) {
      // Say why on the sign-in screen (e.g. "domain not verified"), not just "something went wrong".
      const why = String((e as Error)?.message ?? e).slice(0, 180);
      console.error(`sign-in email failed: ${why}`);
      throw new ConvexError(`Couldn't send the code email. ${why}`);
    }
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [EmailCode],
  // Wrong codes: 5 tries an hour per email.
  signIn: { maxFailedAttempsPerHour: 5 },
  callbacks: {
    // Who may sign in, decided on the server for every attempt (decideSignIn below).
    async createOrUpdateUser(genericCtx, args) {
      return await decideSignIn(genericCtx as unknown as MutationCtx, {
        email: args.profile.email,
        existingUserId: (args.existingUserId as Id<"users"> | null) ?? null,
        verified: args.type === "verification",
      });
    },
  },
});

/** Who may sign in. Runs when a code is requested (so nobody outside the list ever gets an email) and when it's checked. */
export async function decideSignIn(
  ctx: MutationCtx,
  args: { email: unknown; existingUserId: Id<"users"> | null; verified: boolean },
): Promise<Id<"users">> {
  const email = normEmail(args.email);
  const { verified } = args;
  const invite = await ctx.db.query("invites").withIndex("by_email", (q) => q.eq("email", email)).first();
  const isAdmin = adminEmails().includes(email);

  if (args.existingUserId) {
    const id = args.existingUserId;
    const u = await ctx.db.get(id);
    if (!u || u.disabled) throw new ConvexError(REMOVED);
    if (!isAdmin && !invite) throw new ConvexError(NOT_INVITED);
    const patch: Record<string, unknown> = {};
    if (verified) {
      patch.lastSignInAt = Date.now();
      patch.emailVerificationTime = Date.now();
      if (invite && !invite.acceptedAt) await ctx.db.patch(invite._id, { acceptedAt: Date.now() });
    }
    if (isAdmin && u.role !== "admin") patch.role = "admin";
    if (Object.keys(patch).length) await ctx.db.patch(id, patch);
    return id;
  }

  if (!isAdmin && !invite) throw new ConvexError(NOT_INVITED);
  const id = await ctx.db.insert("users", {
    email,
    role: isAdmin ? "admin" : invite!.role,
    ...(invite?.name ? { name: invite.name } : {}),
    ...(verified ? { emailVerificationTime: Date.now(), lastSignInAt: Date.now() } : {}),
  });
  if (verified && invite && !invite.acceptedAt) await ctx.db.patch(invite._id, { acceptedAt: Date.now() });
  return id;
}
