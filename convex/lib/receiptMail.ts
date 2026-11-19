// The receipt email and the Sheet row, built from a sent receipt. Pure (tested directly).
import { esc } from "./email";

export type SentReceipt = {
  number: number;
  vendor?: string; vendorAddress?: string; date?: string; time?: string;
  subtotal?: number; tax?: number; tip?: number; total?: number;
  paymentMethod?: string; cardLast4?: string;
  items?: Array<{ description: string; quantity?: number; amount?: number }>;
  clientName?: string; shootName?: string; categoryName?: string; note?: string;
  senderName?: string; senderEmail?: string; sentAt?: number; sentTo?: string[];
};

export const receiptNo = (n: number) => `ICG-${String(n).padStart(4, "0")}`;
const usd = (n?: number) => (n === undefined ? "—" : "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
const day = (d?: string) => {
  if (!d) return "—";
  const dt = new Date(d + "T12:00:00Z");
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const sentWhen = (ms?: number) =>
  ms ? new Date(ms).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const paid = (r: SentReceipt) => [r.paymentMethod, r.cardLast4 ? `••${r.cardLast4}` : ""].filter(Boolean).join(" ") || "—";
const job = (r: SentReceipt) => [r.clientName, r.shootName].filter(Boolean).join(" › ") || "—";

export function photoFileName(r: SentReceipt) {
  const v = (r.vendor ?? "receipt").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "receipt";
  return `${receiptNo(r.number)}_${r.date ?? "nodate"}_${v}.jpg`;
}

export function receiptSubject(r: SentReceipt) {
  return ["Receipt", usd(r.total), r.categoryName, job(r) !== "—" ? job(r) : null, r.senderName].filter(Boolean).join(" · ");
}

export function receiptMail(r: SentReceipt) {
  const rows: Array<[string, string]> = [
    ["Client › shoot", job(r)],
    ["Category", r.categoryName ?? "—"],
    ["Vendor", [r.vendor, r.vendorAddress].filter(Boolean).join(", ") || "—"],
    ["Date", [day(r.date), r.time].filter((x) => x && x !== "—").join(", ") || "—"],
    ["Subtotal / Tax / Tip", `${usd(r.subtotal)} / ${usd(r.tax)} / ${usd(r.tip)}`],
    ["Total", usd(r.total)],
    ["Paid with", paid(r)],
    ["Submitted by", `${r.senderName ?? ""} · ${sentWhen(r.sentAt)}`],
  ];
  if (r.note) rows.push(["Note", r.note]);
  const items = (r.items ?? []).map((i) => `${i.quantity && i.quantity !== 1 ? `${i.quantity} × ` : ""}${i.description}${i.amount !== undefined ? ` — ${usd(i.amount)}` : ""}`);

  const text =
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    (items.length ? `\n\nLine items:\n${items.map((i) => `• ${i}`).join("\n")}` : "") +
    `\n\nReceipt ${receiptNo(r.number)} · photo attached · sent with ICGceipt`;

  const tr = ([k, v]: [string, string]) =>
    `<tr><td style="padding:8px 12px 8px 0;color:#6b6866;font-size:13px;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
    `<td style="padding:8px 0;font-size:15px;${k === "Total" ? "font-size:22px;font-weight:800" : ""}">${esc(v)}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px 16px;background:#FFFDE9;color:#201F1F;font:15px/1.45 -apple-system,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e3d4;border-radius:16px;padding:22px">
<p style="margin:0 0 4px;font-weight:800;font-size:20px;letter-spacing:-.02em">ICG<span style="color:#EF2600">ceipt</span> <span style="color:#6b6866;font-weight:700;font-size:14px">${esc(receiptNo(r.number))}</span></p>
<table role="presentation" style="border-collapse:collapse;width:100%;margin-top:10px">${rows.map(tr).join("")}</table>
${items.length ? `<p style="margin:16px 0 6px;font-weight:800;font-size:13px;color:#6b6866">LINE ITEMS</p><ul style="margin:0;padding-left:18px">${items.map((i) => `<li style="margin:2px 0">${esc(i)}</li>`).join("")}</ul>` : ""}
<p style="margin:18px 0 0;color:#6b6866;font-size:13px">📎 Receipt photo attached. Reply to reach ${esc(r.senderName ?? "the sender")} directly.</p>
</div></body></html>`;
  return { subject: receiptSubject(r), text, html };
}

/** One row for the ICG Sheet (the Apps Script writes these under matching headers). */
export function sheetRow(r: SentReceipt) {
  return {
    "Receipt #": receiptNo(r.number),
    "Sent": sentWhen(r.sentAt),
    "Sent by": r.senderName ?? "",
    "Client": r.clientName ?? "",
    "Shoot": r.shootName ?? "",
    "Category": r.categoryName ?? "",
    "Vendor": r.vendor ?? "",
    "Where": r.vendorAddress ?? "",
    "Date": r.date ?? "",
    "Subtotal": r.subtotal ?? "",
    "Tax": r.tax ?? "",
    "Tip": r.tip ?? "",
    "Total": r.total ?? "",
    "Paid with": paid(r) === "—" ? "" : paid(r),
    "Note": r.note ?? "",
    "Items": (r.items ?? []).map((i) => `${i.description}${i.amount !== undefined ? ` ${i.amount.toFixed(2)}` : ""}`).join("; "),
    "Sent to": (r.sentTo ?? []).join(", "),
  };
}

/** Same vendor + date + total = probably the same receipt sent twice. */
export function dupKey(vendor?: string, date?: string, total?: number) {
  if (!vendor || !date || total === undefined) return undefined;
  return `${vendor.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20)}|${date}|${total.toFixed(2)}`;
}
