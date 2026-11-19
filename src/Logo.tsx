export function Logo({ big = false }: { big?: boolean }) {
  return (
    <div className={big ? "logo big" : "logo"} aria-label="ICGceipt">
      ICG<span>ceipt</span>
    </div>
  );
}
