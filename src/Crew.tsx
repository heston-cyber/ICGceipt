import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { errText } from "./lib";

// Admin: who can use ICGceipt.
export function Crew() {
  const data = useQuery(api.users.crew);
  const invite = useMutation(api.users.invite);
  const setRole = useMutation(api.users.setRole);
  const remove = useMutation(api.users.remove);
  const cancel = useMutation(api.users.cancelInvite);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRoleVal] = useState<"crew" | "admin">("crew");
  const [msg, setMsg] = useState("");
  const [confirm, setConfirm] = useState<Id<"users"> | null>(null);

  const run = async (f: () => Promise<unknown>, ok = "") => {
    setMsg("");
    try { await f(); if (ok) setMsg(ok); } catch (e) { setMsg(errText(e)); }
  };

  return (
    <div className="stack">
      <h1>crew.</h1>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await invite({ email, name: name || undefined, role });
            setEmail(""); setName("");
          }, "Added. They'll get an email with how to get in.");
        }}
      >
        <label htmlFor="ie">Add someone</label>
        <input id="ie" type="email" inputMode="email" autoCapitalize="none" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="seg">
          <button type="button" className={role === "crew" ? "on" : ""} onClick={() => setRoleVal("crew")}>Crew</button>
          <button type="button" className={role === "admin" ? "on" : ""} onClick={() => setRoleVal("admin")}>Admin</button>
        </div>
        {msg && <p className="small">{msg}</p>}
        <button className="btn primary">Add</button>
      </form>

      {data === undefined ? <p className="muted">Loading…</p> : (
        <>
          <ul className="list">
            {data.people.map((p) => (
              <li key={p._id}>
                <div className="grow">
                  <b>{p.name || p.email}</b>{p.isMe && <span className="pill">you</span>}
                  <div className="muted small">{p.email}</div>
                </div>
                {p.locked || p.isMe ? <span className="pill solid">{p.role}</span> : (
                  <div className="row-actions">
                    <button className="pill" onClick={() => void run(() => setRole({ userId: p._id, role: p.role === "admin" ? "crew" : "admin" }))}>{p.role}</button>
                    {confirm === p._id
                      ? <button className="pill danger" onClick={() => void run(() => remove({ userId: p._id }), "Removed.").then(() => setConfirm(null))}>confirm</button>
                      : <button className="pill" onClick={() => setConfirm(p._id)}>remove</button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {data.pending.length > 0 && (
            <>
              <h2>invited, not signed in yet</h2>
              <ul className="list">
                {data.pending.map((p) => (
                  <li key={p._id}>
                    <div className="grow">
                      <b>{p.name || p.email}</b>
                      <div className="muted small">{p.email} · {p.role}</div>
                    </div>
                    <button className="pill" onClick={() => void run(() => cancel({ inviteId: p._id }))}>cancel</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
