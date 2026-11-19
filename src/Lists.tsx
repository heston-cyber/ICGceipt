import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { errText } from "./lib";

type Kind = "clients" | "shoots" | "categories";

// Admin: clients › shoots, categories and the shared recipients. Rename, delete (archives if used), restore.
export function Lists() {
  const lists = useQuery(api.tags.lists, { includeArchived: true });
  const recips = useQuery(api.recipients.mine);
  const rename = useMutation(api.tags.rename);
  const remove = useMutation(api.tags.remove);
  const restore = useMutation(api.tags.restore);
  const addClient = useMutation(api.tags.addClient);
  const addShoot = useMutation(api.tags.addShoot);
  const addCategory = useMutation(api.tags.addCategory);
  const addShared = useMutation(api.recipients.addShared);
  const setDefault = useMutation(api.recipients.setDefault);
  const removeRecip = useMutation(api.recipients.remove);
  const [msg, setMsg] = useState("");
  const [edit, setEdit] = useState<{ kind: Kind; id: string; name: string } | null>(null);
  const [nc, setNc] = useState("");
  const [ncat, setNcat] = useState("");
  const [ns, setNs] = useState<Record<string, string>>({});
  const [re, setRe] = useState({ email: "", name: "", isDefault: true });

  const run = async (f: () => Promise<unknown>, ok = "") => {
    setMsg("");
    try { const r = await f(); if (r === "archived") setMsg("It's on sent receipts, so it was archived (hidden) instead of deleted."); else if (ok) setMsg(ok); } catch (e) { setMsg(errText(e)); }
  };
  if (!lists || !recips) return <p className="muted">Loading…</p>;

  const Row = ({ kind, id, name, archived }: { kind: Kind; id: string; name: string; archived: boolean }) =>
    edit?.id === id ? (
      <span className="row-edit">
        <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus />
        <button className="pill" onClick={() => void run(() => rename({ kind, id, name: edit.name })).then(() => setEdit(null))}>save</button>
        <button className="pill" onClick={() => setEdit(null)}>cancel</button>
      </span>
    ) : (
      <span className="row-line">
        <span className={archived ? "grow muted strike" : "grow"}>{name}</span>
        {archived ? <button className="pill" onClick={() => void run(() => restore({ kind, id }))}>restore</button> : <>
          <button className="pill" onClick={() => setEdit({ kind, id, name })}>rename</button>
          <button className="pill" onClick={() => void run(() => remove({ kind, id }))}>delete</button>
        </>}
      </span>
    );

  return (
    <div className="stack">
      {msg && <p className="small">{msg}</p>}

      <h2>clients › shoots</h2>
      <ul className="list">
        {lists.clients.map((c) => (
          <li key={c._id} className="col">
            <Row kind="clients" id={c._id} name={c.name} archived={c.archived} />
            <ul className="sub">
              {lists.shoots.filter((s) => s.clientId === c._id).map((s) => (
                <li key={s._id}><Row kind="shoots" id={s._id} name={s.name} archived={s.archived} /></li>
              ))}
              {!c.archived && (
                <li className="row-edit">
                  <input placeholder="+ shoot" value={ns[c._id] ?? ""} onChange={(e) => setNs({ ...ns, [c._id]: e.target.value })} />
                  <button className="pill" onClick={() => void run(() => addShoot({ clientId: c._id as Id<"clients">, name: ns[c._id] ?? "" })).then(() => setNs({ ...ns, [c._id]: "" }))}>add</button>
                </li>
              )}
            </ul>
          </li>
        ))}
      </ul>
      <span className="row-edit">
        <input placeholder="New client" value={nc} onChange={(e) => setNc(e.target.value)} />
        <button className="pill" onClick={() => void run(() => addClient({ name: nc })).then(() => setNc(""))}>add</button>
      </span>

      <h2>categories</h2>
      <ul className="list">
        {lists.categories.map((c) => <li key={c._id}><Row kind="categories" id={c._id} name={c.name} archived={c.archived} /></li>)}
      </ul>
      <span className="row-edit">
        <input placeholder="New category" value={ncat} onChange={(e) => setNcat(e.target.value)} />
        <button className="pill" onClick={() => void run(() => addCategory({ name: ncat })).then(() => setNcat(""))}>add</button>
      </span>

      <h2>shared recipients</h2>
      <p className="muted small">Everyone sees these when sending. “Ticked” ones are pre-selected.</p>
      <ul className="list">
        {recips.shared.map((r) => (
          <li key={r._id}>
            <div className="grow"><b>{r.name || r.email}</b>{r.name && <div className="muted small">{r.email}</div>}</div>
            <button className={r.isDefault ? "pill solid" : "pill"} onClick={() => void run(() => setDefault({ id: r._id, isDefault: !r.isDefault }))}>{r.isDefault ? "ticked" : "not ticked"}</button>
            <button className="pill" onClick={() => void run(() => removeRecip({ id: r._id }))}>remove</button>
          </li>
        ))}
      </ul>
      <div className="card">
        <input type="email" inputMode="email" autoCapitalize="none" placeholder="email" value={re.email} onChange={(e) => setRe({ ...re, email: e.target.value })} />
        <input placeholder="name, e.g. ICG Accounting (optional)" value={re.name} onChange={(e) => setRe({ ...re, name: e.target.value })} />
        <label className="check small"><input type="checkbox" checked={re.isDefault} onChange={(e) => setRe({ ...re, isDefault: e.target.checked })} /><span>Pre-tick for everyone</span></label>
        <button className="btn" onClick={() => void run(() => addShared({ email: re.email, name: re.name || undefined, isDefault: re.isDefault })).then(() => setRe({ email: "", name: "", isDefault: true }))}>Add shared recipient</button>
      </div>
    </div>
  );
}

/** Me tab: my own saved addresses. */
export function MyRecipients() {
  const recips = useQuery(api.recipients.mine);
  const remove = useMutation(api.recipients.remove);
  if (!recips || !recips.own.length) return null;
  return (
    <div className="card">
      <label>My saved emails</label>
      <ul className="list">
        {recips.own.map((r) => (
          <li key={r._id}><span className="grow">{r.email}</span><button className="pill" onClick={() => void remove({ id: r._id })}>remove</button></li>
        ))}
      </ul>
    </div>
  );
}
