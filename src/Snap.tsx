import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { shrinkPhoto, money, niceDate } from "./photo";
import { errText, isIOS, isStandalone } from "./lib";

// Home: the big Snap button, plus receipts not sent yet.
export function Snap({ name, open }: { name: string; open: (id: Id<"receipts">) => void }) {
  const uploadUrl = useMutation(api.receipts.uploadUrl);
  const create = useMutation(api.receipts.create);
  const drafts = useQuery(api.receipts.myDrafts);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const showInstall = isIOS() && !isStandalone();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      setBusy("Getting the photo ready…");
      const photo = await shrinkPhoto(file);
      setBusy("Uploading…");
      const url = await uploadUrl();
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": photo.type || "image/jpeg" }, body: photo });
      if (!res.ok) throw new Error("Upload failed. Check your signal and try again.");
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      const made = await create({ photo: storageId });
      if ("error" in made) throw new Error(made.error);
      open(made.id);
    } catch (err) {
      setError(err instanceof Error && !("data" in err) ? err.message : errText(err));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="stack">
      <h1>hey {name.split(" ")[0].toLowerCase()}.</h1>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
      <input ref={library} type="file" accept="image/*" hidden onChange={onFile} />
      <button className="snap" disabled={!!busy} onClick={() => camera.current?.click()}>
        <span className="snap-icon" aria-hidden>◉</span>
        {busy || "Snap receipt"}
      </button>
      <button className="btn link" disabled={!!busy} onClick={() => library.current?.click()}>or pick a photo</button>
      {error && <p className="error center-text">{error}</p>}

      {drafts && drafts.length > 0 && (
        <>
          <h2>not sent yet</h2>
          <ul className="list">
            {drafts.map((d) => (
              <li key={d._id} className="tap" onClick={() => open(d._id)}>
                <div className="grow">
                  <b>{d.read === "reading" ? "Reading…" : d.vendor ?? "Receipt"}</b>
                  <div className="muted small">
                    {[niceDate(d.date), d.read === "failed" ? "couldn't read" : null, d.flagged ? `${d.flagged} to check` : null].filter(Boolean).join(" · ") || new Date(d.createdAt).toLocaleString()}
                  </div>
                </div>
                <b>{money(d.total)}</b>
              </li>
            ))}
          </ul>
        </>
      )}

      {showInstall && (
        <div className="card hint">
          <b>Put ICGceipt on your home screen</b>
          <p>Tap <b>Share</b> at the bottom of Safari, then <b>Add to Home Screen</b>. Sign in once more inside the app.</p>
        </div>
      )}
    </div>
  );
}
