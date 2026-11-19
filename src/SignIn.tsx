import { useEffect, useRef, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Logo } from "./Logo";
import { errText } from "./lib";

// Sign in with an emailed 6-digit code. The same email has a one-tap link (?signin=CODE&email=...),
// which signs in straight away when opened in the browser.
export function SignIn() {
  const { signIn } = useAuthActions();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState(() => localStorage.getItem("icg.email") ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tried = useRef(false);

  // One-tap link from the email.
  useEffect(() => {
    if (tried.current) return;
    const q = new URLSearchParams(location.search);
    const c = q.get("signin"), e = q.get("email");
    if (!c || !e) return;
    tried.current = true;
    history.replaceState(null, "", location.pathname);
    setEmail(e);
    setCode(c);
    setStep("code");
    void verify(e, c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendCode(ev?: React.FormEvent) {
    ev?.preventDefault();
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return setError("Enter your email.");
    setBusy(true);
    setError("");
    try {
      await signIn("email", { email: e });
      localStorage.setItem("icg.email", e);
      setEmail(e);
      setStep("code");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e = email, c = code) {
    const digits = c.replace(/\D/g, "");
    if (digits.length !== 6) return setError("Enter the 6-digit code.");
    setBusy(true);
    setError("");
    try {
      await signIn("email", { email: e.trim().toLowerCase(), code: digits });
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <div className="screen signin">
      <div className="hero">
        <Logo big />
        <p className="tag">snap it. tag it. send it.</p>
      </div>

      {step === "email" ? (
        <form className="card" onSubmit={sendCode}>
          <label htmlFor="email">Your email</label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            placeholder="you@icgadv.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy}>{busy ? "Sending…" : "Email me a code"}</button>
        </form>
      ) : (
        <form className="card" onSubmit={(ev) => { ev.preventDefault(); void verify(); }}>
          <p className="muted">We sent a code to <b>{email}</b>.</p>
          <label htmlFor="code">6-digit code</label>
          <input
            id="code"
            className="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            placeholder="123456"
            value={code}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(v);
              if (v.length === 6 && !busy) void verify(email, v);
            }}
            autoFocus
          />
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
          <button type="button" className="btn link" onClick={() => { setStep("email"); setCode(""); setError(""); }}>
            Use a different email
          </button>
          <button type="button" className="btn link" disabled={busy} onClick={() => void sendCode()}>
            Send a new code
          </button>
        </form>
      )}
    </div>
  );
}
