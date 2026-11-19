import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { money } from "./photo";
import { errText } from "./lib";

type Key = "vendor" | "vendorAddress" | "date" | "subtotal" | "tax" | "tip" | "total" | "paymentMethod" | "cardLast4";
const NUMS: Key[] = ["subtotal", "tax", "tip", "total"];

// The review card: the photo, and every field the AI read, editable. Flagged fields say what to check.
export function Receipt({ id, close }: { id: Id<"receipts">; close: () => void }) {
  const r = useQuery(api.receipts.get, { id });
  const update = useMutation(api.receipts.update);
  const discard = useMutation(api.receipts.discard);
  const reread = useMutation(api.receipts.reread);
  const [zoom, setZoom] = useState(false);
  const [msg, setMsg] = useState("");
  const [sure, setSure] = useState(false);

  if (r === undefined) return <div className="stack"><p className="muted">Loading…</p></div>;
  if (r === null) return <div className="stack"><p>That receipt is gone.</p><button className="btn" onClick={close}>Back</button></div>;

  const flags = (r.flags ?? {}) as Record<string, string>;
  const canEdit = r.mine && r.status === "draft" && r.read !== "reading";
  const save = async (k: Key, raw: string) => {
    setMsg("");
    let val: string | number | null = raw.trim();
    if (NUMS.includes(k)) {
      if (!val) val = null;
      else {
        const n = Number(String(val).replace(/[^0-9.]/g, ""));
        if (!Number.isFinite(n)) return setMsg(`Check the ${k}.`);
        val = n;
      }
    } else if (!val) val = null;
    try { await update({ id, [k]: val }); } catch (e) { setMsg(errText(e)); }
  };

  return (
    <div className="stack receipt">
      <div className="row-between">
        <button className="btn link back" onClick={close}>‹ back</button>
        {r.read === "done" && r.readModel && <span className="muted small">read in {Math.max(1, Math.round((r.readMs ?? 0) / 1000))}s</span>}
      </div>

      <button className={zoom ? "photo zoom" : "photo"} onClick={() => setZoom(!zoom)} aria-label="Receipt photo (tap to zoom)">
        {r.photoUrl && <img src={r.photoUrl} alt="Receipt" />}
        {r.read === "reading" && <span className="reading"><span className="dot" />Reading receipt…</span>}
      </button>

      {r.read === "failed" && (
        <div className="card warn">
          <b>{r.readError ?? "Couldn't read it."}</b>
          <p>Try again, or fill it in by hand below.</p>
          {r.mine && <button className="btn" onClick={() => void reread({ id }).catch((e) => setMsg(errText(e)))}>Try again</button>}
        </div>
      )}
      {r.read === "done" && r.isReceipt === false && (
        <div className="card warn">
          <b>This doesn't look like a receipt.</b>
          <p>Retake it, or fill it in by hand if it is one.</p>
        </div>
      )}

      {r.read !== "reading" && (
        <>
          <div className="card fields">
            <Field label="Total" k="total" value={r.total} flag={flags.total} big money disabled={!canEdit} onSave={save} />
            <Field label="Vendor" k="vendor" value={r.vendor} flag={flags.vendor} disabled={!canEdit} onSave={save} />
            <Field label="Date" k="date" value={r.date} flag={flags.date} type="date" disabled={!canEdit} onSave={save} />
            <div className="three">
              <Field label="Subtotal" k="subtotal" value={r.subtotal} flag={flags.subtotal} money disabled={!canEdit} onSave={save} />
              <Field label="Tax" k="tax" value={r.tax} flag={flags.tax} money disabled={!canEdit} onSave={save} />
              <Field label="Tip" k="tip" value={r.tip} flag={flags.tip} money disabled={!canEdit} onSave={save} />
            </div>
            <div className="two">
              <Field label="Paid with" k="paymentMethod" value={r.paymentMethod} disabled={!canEdit} onSave={save} />
              <Field label="Card last 4" k="cardLast4" value={r.cardLast4} numeric disabled={!canEdit} onSave={save} />
            </div>
            <Field label="Where" k="vendorAddress" value={r.vendorAddress} disabled={!canEdit} onSave={save} />
          </div>

          {(r.items?.length ?? 0) > 0 && (
            <details className="card items">
              <summary><b>{r.items!.length} line item{r.items!.length === 1 ? "" : "s"}</b>{flags.items && <span className="flag"> · {flags.items}</span>}</summary>
              <ul>
                {r.items!.map((it, i) => (
                  <li key={i}><span>{it.quantity && it.quantity !== 1 ? `${it.quantity} × ` : ""}{it.description}</span><span>{money(it.amount)}</span></li>
                ))}
              </ul>
            </details>
          )}
          {r.aiNotes && <p className="muted small">Note: {r.aiNotes}</p>}
          {msg && <p className="error">{msg}</p>}

          {r.mine && r.status === "draft" && (
            <>
              <button className="btn primary" disabled title="Phase 4">Tag &amp; send — coming next</button>
              {sure ? (
                <button className="btn danger" onClick={async () => { await discard({ id }); close(); }}>Yes, throw it away</button>
              ) : (
                <button className="btn" onClick={() => setSure(true)}>Discard</button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Field(props: {
  label: string; k: Key; value: string | number | undefined; flag?: string; big?: boolean; money?: boolean;
  numeric?: boolean; type?: string; disabled?: boolean; onSave: (k: Key, v: string) => Promise<void>;
}) {
  const shown = (v: string | number | undefined) => (v === undefined || v === null ? "" : typeof v === "number" ? v.toFixed(2) : v);
  const [val, setVal] = useState(shown(props.value));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setVal(shown(props.value)); }, [props.value, focus]);
  return (
    <label className={`field${props.big ? " big" : ""}${props.flag ? " flagged" : ""}`}>
      <span className="lbl">{props.label}</span>
      <span className="inwrap">
        {props.money && <span className="cur">$</span>}
        <input
          value={val}
          type={props.type ?? "text"}
          inputMode={props.money ? "decimal" : props.numeric ? "numeric" : undefined}
          maxLength={props.k === "cardLast4" ? 4 : undefined}
          disabled={props.disabled}
          onFocus={() => setFocus(true)}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => { setFocus(false); if (val !== shown(props.value)) void props.onSave(props.k, val); }}
        />
      </span>
      {props.flag && <span className="flag">{props.flag}</span>}
    </label>
  );
}
