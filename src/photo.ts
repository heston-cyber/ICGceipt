// Shrinks a phone photo before upload: upright (EXIF), at most 2000px on the long edge, JPEG.
// iPhone HEIC photos come out as JPEG too. A 12MP photo (~3–5 MB) becomes ~300–700 KB.
const MAX_EDGE = 2000;

export async function shrinkPhoto(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error("bad image");
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("no canvas");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, cw, ch);
    g.drawImage(img, 0, 0, cw, ch);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!blob) throw new Error("encode failed");
    return blob;
  } catch {
    // Couldn't decode here: send the original if it's a normal image type.
    if (/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    throw new Error("That photo couldn't be opened. Try taking it again.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export const niceDate = (d?: string | null) => {
  if (!d) return "";
  const dt = new Date(d + "T12:00:00");
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
