// Uses the published A-Border logo without recoloring or redrawing it.
export type LogoVariant = "lockup" | "mark" | "stacked";

export function Logo({ variant = "lockup", className = "", decorative = false }: {
  variant?: LogoVariant; className?: string; decorative?: boolean;
}) {
  const mark = variant === "mark";
  return (
    // Local brand assets need no image proxy or request to the public website.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={mark ? "/brand/a-border-symbol.svg" : "/brand/a-border-logo.png"}
      width={mark ? 96 : 1600}
      height={mark ? 96 : 409}
      alt={decorative ? "" : "A-Border"}
      aria-hidden={decorative || undefined}
      className={["block w-auto shrink-0 object-contain", className].filter(Boolean).join(" ")}
      decoding="async"
    />
  );
}