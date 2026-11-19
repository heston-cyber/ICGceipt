import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { errText } from "./lib";
import { money } from "./photo";

const NEW = "__new__";

// Tag the receipt (client › shoot, category, note), pick who gets it, send.
export function SendPanel({ id, total, onSent }: { id: Id<"receipts">; total?: number; onSent: () => void }) {
  const lists = useQuery(api.tags.lists, {});
  const recips = useQuery(api.recipients.mine);
  const ensureDefaults = useMutation(api.tags.ensureDefaults);
  const addClient = useMutation(api.tags.addClient);
  const addShoot = useMutation(api.tags.addShoot);
  const addCategory = useMutation(api.tags.addCategory);
  const saveMine = useMutation(api.recipients.saveMine);
  const send = useMutation(api.receipts.send);

  const [clientId, setClientId] = useState(() => localStorage.getItem("icg.client") ?? "");
  const [shootId, setShootId] = useState(() => localStorage.getItem("icg.shoot") ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [extra, setExtra] = useState("");
  const [saveExtra, setSaveExtra] = useState(true);
  const [newClient, setNewClient] = useState("");
  const [newShoot, setNewShoot] = useState("");
  const [newCat, setNewCat] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [dup, setDup] = useState<{ number: string; by: string; at: number } | null>(null);

  useEffect(() => { if (lists && !lists.categories.length) void ensureDefaults({}); }, [lists, ensureDefaults]);
  // The last client/shoot used is remembered (most receipts on a shoot day go to the same one) — if it still exists.
  const shoots = useMemo(() => (lists?.shoots ?? []).filter((s) => s.clientId === clientId), [lists, clientId]);
  useEffect(() => {
    if (!lists) return;
    if (clientId && clientId !== NEW && !lists.clients.some((c) => c._id === clientId)) setClientId("");
    if (shootId && shootId !== NEW && !shoots.some((s) => s._id === shootId)) setShootId("");
  }, [lists, clientId, shootId, shoots]);
  // Shared "default" recipients start ticked.
  useEffect(() => {
    if (recips && picked === null) setPicked(new Set(recips.shared.filter((r) => r.isDefault).map((r) => r.email)));
  }, [recips, picked]);

  if (!lists || !recips || picked === null) return <p className="muted">Loading…</p>;
  const toggle = (e: string) => setPicked((p) => { const n = new Set(p); if (n.has(e)) n.delete(e); else n.add(e); return n; });

  async function go(confirmDuplicate = false) {
    setMsg("");
    setBusy(true);
    try {
      let cid = clientId;
      if (cid === NEW) {
        if (!newClient.trim()) throw new Error("Type the new client's name.");
        cid = await addClient({ name: newClient });
      }
      if (!cid) throw new Error("Pick a client.");
      let sid: string | undefined = shootId || undefined;
      if (sid === NEW) {
        sid = newShoot.trim() ? await addShoot({ clientId: cid as Id<"clients">, name: newShoot }) : undefined;
      }
      if (!categoryId) throw new Error("Pick a category.");
      const to = [...picked!];
      const typed = extra.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
      to.push(...typed);
      if (!to.length) throw new Error("Pick or type at least one email.");
      const res = await send({
        id, clientId: cid as Id<"clients">, shootId: sid as Id<"shoots"> | undefined,
        categoryId: categoryId as Id<"categories">, note: note || undefined, to, confirmDuplicate,
      });
      if ("duplicate" in res) { setDup(res.duplicate); return; }
      localStorage.setItem("icg.client", cid);
      localStorage.setItem("icg.shoot", sid ?? "");
      if (saveExtra) for (const e of typed) await saveMine({ email: e }).catch(() => {});
      onSent();
    } catch (e) {
      setMsg(e instanceof Error && !("data" in e) ? e.message : errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card send">
      <label htmlFor="cl">Client</label>
      <select id="cl" value={clientId} onChange={(e) => { setClientId(e.target.value); setShootId(""); }}>
        <option value="">Pick a client…</option>
        {lists.clients.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
        <option value={NEW}>+ New client…</option>
      </select>
      {clientId === NEW && <input placeholder="Client name" value={newClient} onChange={(e) => setNewClient(e.target.value)} autoFocus />}

      {clientId && (
        <>
          <label htmlFor="sh">Shoot <span className="muted small">(optional)</span></label>
          <select id="sh" value={shootId} onChange={(e) => setShootId(e.target.value)}>
            <option value="">No specific shoot</option>
            {shoots.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
            <option value={NEW}>+ New shoot…</option>
          </select>
          {shootId === NEW && <input placeholder="Shoot name" value={newShoot} onChange={(e) => setNewShoot(e.target.value)} autoFocus />}
        </>
      )}

      <label>Category</label>
      <div className="chips">
        {lists.categories.map((c) => (
          <button key={c._id} type="button" className={categoryId === c._id ? "chip on" : "chip"} onClick={() => setCategoryId(c._id)}>{c.name}</button>
        ))}
        {newCat === null ? (
          <button type="button" className="chip add" onClick={() => setNewCat("")}>+ add</button>
        ) : (
          <span className="chip-add">
            <input placeholder="New category" value={newCat} onChange={(e) => setNewCat(e.target.value)} autoFocus />
            <button type="button" className="pill" onClick={async () => {
              try { const cid = await addCategory({ name: newCat }); setCategoryId(cid); setNewCat(null); } catch (e) { setMsg(errText(e)); }
            }}>add</button>
          </span>
        )}
      </div>

      <label htmlFor="nt">Note <span className="muted small">(optional)</span></label>
      <textarea id="nt" rows={2} placeholder="e.g. water + snacks for crew" value={note} onChange={(e) => setNote(e.target.value)} />

      <label>Send to</label>
      <div className="recips">
        {recips.shared.map((r) => (
          <label key={r._id} className="check"><input type="checkbox" checked={picked.has(r.email)} onChange={() => toggle(r.email)} /><span>{r.name || r.email}{r.name && <span className="muted small"> {r.email}</span>}</span></label>
        ))}
        {recips.own.map((r) => (
          <label key={r._id} className="check"><input type="checkbox" checked={picked.has(r.email)} onChange={() => toggle(r.email)} /><span>{r.name || r.email}</span></label>
        ))}
        <input type="email" inputMode="email" autoCapitalize="none" placeholder="another email" value={extra} onChange={(e) => setExtra(e.target.value)} />
        {extra.trim() && <label className="check small"><input type="checkbox" checked={saveExtra} onChange={(e) => setSaveExtra(e.target.checked)} /><span>Save for next time</span></label>}
      </div>
      <p className="muted small">Goes out as “your name via ICGceipt”. Replies come to you, and you get a copy.</p>

      {msg && <p className="error">{msg}</p>}
      {dup ? (
        <div className="card warn">
          <b>Looks like this was already sent</b>
          <p>{dup.number}, by {dup.by} on {new Date(dup.at).toLocaleDateString()}: same vendor, date and total.</p>
          <button className="btn primary" disabled={busy} onClick={() => { setDup(null); void go(true); }}>Send it anyway</button>
          <button className="btn" onClick={() => setDup(null)}>Don't send</button>
        </div>
      ) : (
        <button className="btn primary" disabled={busy} onClick={() => void go()}>{busy ? "Sending…" : `Send ${money(total) || "receipt"}`}</button>
      )}
    </div>
  );
}
