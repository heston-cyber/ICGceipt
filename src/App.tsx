import { useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";
import { SignIn } from "./SignIn";
import { Logo } from "./Logo";
import { Crew } from "./Crew";
import { Lists, MyRecipients } from "./Lists";
import { Snap } from "./Snap";
import { Receipt } from "./Receipt";
import type { Id } from "../convex/_generated/dataModel";
import { errText } from "./lib";

type Tab = "snap" | "crew" | "me";

export default function App() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return <div className="screen center"><Logo big /></div>;
  if (!isAuthenticated) return <SignIn />;
  return <SignedIn />;
}

function SignedIn() {
  const me = useQuery(api.users.me);
  const { signOut } = useAuthActions();
  const [tab, setTab] = useState<Tab>("snap");
  const [openId, setOpenId] = useState<Id<"receipts"> | null>(null);

  if (me === undefined) return <div className="screen center"><Logo big /></div>;
  if (me === null)
    return (
      <div className="screen center">
        <Logo big />
        <p className="muted">This account can't use ICGceipt right now.</p>
        <button className="btn" onClick={() => void signOut()}>Sign out</button>
      </div>
    );
  if (!me.name) return <NameStep />;

  return (
    <div className="app">
      <header className="top">
        <Logo />
        <span className="who">{me.name.split(" ")[0]}</span>
      </header>
      <main className="screen">
        {openId ? <Receipt id={openId} close={() => setOpenId(null)} /> : <>
        {tab === "snap" && <Snap name={me.name} open={setOpenId} />}
        {tab === "crew" && me.role === "admin" && <Admin />}
        {tab === "me" && <Me email={me.email} name={me.name} role={me.role} />}
        </>}
      </main>
      <nav className="tabs">
        <button className={tab === "snap" ? "on" : ""} onClick={() => { setTab("snap"); setOpenId(null); }}>Snap</button>
        {me.role === "admin" && <button className={tab === "crew" ? "on" : ""} onClick={() => { setTab("crew"); setOpenId(null); }}>Admin</button>}
        <button className={tab === "me" ? "on" : ""} onClick={() => { setTab("me"); setOpenId(null); }}>Me</button>
      </nav>
    </div>
  );
}

function NameStep() {
  const setName = useMutation(api.users.setMyName);
  const [name, setNameVal] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="screen signin">
      <div className="hero"><Logo big /></div>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          try { await setName({ name }); } catch (err) { setError(errText(err)); }
        }}
      >
        <label htmlFor="nm">Your name</label>
        <p className="muted small">It's how receipts are signed: “{name.trim() || "Your Name"} via ICGceipt”.</p>
        <input id="nm" autoComplete="name" placeholder="First Last" value={name} onChange={(e) => setNameVal(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <button className="btn primary">Continue</button>
      </form>
    </div>
  );
}

function Me({ email, name, role }: { email: string; name: string; role: string }) {
  const { signOut } = useAuthActions();
  const setName = useMutation(api.users.setMyName);
  const [val, setVal] = useState(name);
  const [msg, setMsg] = useState("");
  return (
    <div className="stack">
      <h1>me.</h1>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          try { await setName({ name: val }); setMsg("Saved."); } catch (err) { setMsg(errText(err)); }
        }}
      >
        <label htmlFor="mn">Name</label>
        <input id="mn" value={val} onChange={(e) => { setVal(e.target.value); setMsg(""); }} />
        <p className="muted small">{email} · {role}</p>
        {msg && <p className="small">{msg}</p>}
        <button className="btn">Save name</button>
      </form>
      <MyRecipients />
      <button className="btn" onClick={() => void signOut()}>Sign out</button>
    </div>
  );
}

function Admin() {
  const [part, setPart] = useState<"lists" | "crew">("lists");
  return (
    <div className="stack">
      <h1>admin.</h1>
      <div className="seg">
        <button className={part === "lists" ? "on" : ""} onClick={() => setPart("lists")}>Lists</button>
        <button className={part === "crew" ? "on" : ""} onClick={() => setPart("crew")}>Crew</button>
      </div>
      {part === "lists" ? <Lists /> : <Crew />}
    </div>
  );
}
