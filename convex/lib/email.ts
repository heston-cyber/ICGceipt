// Outgoing email through Resend. RESEND_API_KEY is set in the Convex dashboard, never in code.
// The sender is a verified hillsbuilds.com address; receipts go out "on behalf of" the crew member
// (their name in the From name, their address as Reply-To and CC) — Phase 4.

export const FROM = () => (process.env.EMAIL_FROM ?? "").trim() || "ICGceipt <receipts@hillsbuilds.com>";

/** "Heston Hill via ICGceipt <receipts@hillsbuilds.com>" — the sender's name on the verified address. */
export function fromOnBehalf(name: string): string {
  const addr = FROM().match(/<([^>]+)>/)?.[1] ?? FROM();
  const clean = name.replace(/["<>\r\n]/g, "").trim().slice(0, 60) || "ICG crew";
  return `"${clean} via ICGceipt" <${addr}>`;
}

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export type Mail = {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html: string;
  from?: string;
  replyTo?: string;
  tag?: string;
  attachments?: Array<{ filename: string; content: string }>; // base64
};

export async function sendEmail(msg: Mail): Promise<string> {
  // Test deployments can hold mail: with EMAIL_ONLY_TO set, mail goes only to those addresses.
  const only = (process.env.EMAIL_ONLY_TO ?? "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (only.length) {
    msg = { ...msg, to: msg.to.filter((t) => only.includes(t.toLowerCase())), cc: msg.cc?.filter((t) => only.includes(t.toLowerCase())) };
    if (!msg.to.length) { console.log(`email held (EMAIL_ONLY_TO): ${msg.tag ?? "email"}`); return "held"; }
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Email isn't set up yet (no Resend key in Convex).");
  const body: Record<string, unknown> = { from: msg.from ?? FROM(), to: msg.to, subject: msg.subject, text: msg.text, html: msg.html };
  if (msg.cc?.length) body.cc = msg.cc;
  if (msg.replyTo) body.reply_to = msg.replyTo;
  if (msg.tag) body.tags = [{ name: "kind", value: msg.tag }];
  if (msg.attachments?.length) body.attachments = msg.attachments;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!r.ok) throw new Error(`Email failed (Resend ${r.status}): ${(j.message || "").slice(0, 160)}`);
  return j.id ?? "";
}

export const sixDigits = () => {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(100000 + (b[0] % 900000));
};

export const SITE = () => (process.env.SITE_URL ?? "").replace(/\/+$/, "") || "https://icgceipt.hillsbuilds.com";

/** The sign-in email: a 6-digit code (works inside the home-screen app) and a one-tap link (works in Safari). */
export function signInMail(code: string, email: string, minutes: number) {
  const link = `${SITE()}/?signin=${code}&email=${encodeURIComponent(email)}`;
  const text =
    `Your ICGceipt sign-in code is ${code}\n\n` +
    `Type it into the app, or tap this link to sign in:\n${link}\n\n` +
    `It works for ${minutes} minutes. If you didn't ask for it, ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;padding:28px 18px;background:#FFFDE9;color:#201F1F;font:16px/1.5 -apple-system,Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto">
<p style="margin:0 0 6px;font-weight:800;letter-spacing:-.02em;font-size:22px">ICG<span style="color:#EF2600">ceipt</span></p>
<p style="margin:18px 0 6px">Your sign-in code</p>
<p style="margin:0 0 18px;font-size:40px;font-weight:800;letter-spacing:.12em">${esc(code)}</p>
<p style="margin:0 0 22px">Type it into the app, or tap below to sign in.</p>
<p style="margin:0 0 26px"><a href="${esc(link)}" style="display:inline-block;background:#EF2600;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:999px">Sign in to ICGceipt</a></p>
<p style="margin:0;color:#6b6866;font-size:13px">Works for ${minutes} minutes. If you didn't ask for it, ignore this email.</p>
</div></body></html>`;
  return { subject: `${code} is your ICGceipt code`, text, html };
}
