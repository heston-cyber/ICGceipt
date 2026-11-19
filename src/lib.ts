/** A readable message from a Convex error (ConvexError data, or the server's message without its stack). */
export function errText(e: unknown): string {
  const data = (e as { data?: unknown })?.data;
  if (typeof data === "string") return data;
  const m = String((e as Error)?.message ?? e);
  const convexErr = m.match(/ConvexError: ([^\n]+)/)?.[1];
  if (convexErr) return convexErr;
  const inner = m.match(/Uncaught (?:ConvexError|Error): ([^\n]+)/)?.[1];
  if (inner) return inner;
  if (/InvalidAccountId|Could not verify code|Invalid verification code/i.test(m)) return "That code didn't work. Check it, or ask for a new one.";
  if (/TooManyFailedAttempts|rate limit/i.test(m)) return "Too many tries. Wait a bit, then ask for a new code.";
  return "Something went wrong. Try again.";
}

export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
