import Link from "next/link";

/** The EURO Tools & Automation mark, in one place.
 *
 *  The chevrons are an SVG file so the artwork can be replaced without
 *  touching this component: drop the real file over `public/logo-mark.svg` and
 *  every screen picks it up. The words beside it are set as text rather than
 *  baked into that file, because the wordmark is nearly black on the company's
 *  white website and would disappear against a dark shop-floor screen. As text
 *  it takes the theme's own foreground and stays legible either way.
 *
 *  `QC` is the application; EURO Tools & Automation is whose it is. Keeping
 *  them visually apart means the header says both without reading as one long
 *  title nobody finishes.
 */
function Mark({ size }: { size: "sm" | "lg" }) {
  const markPx = size === "lg" ? "h-11" : "h-8";
  const euro = size === "lg" ? "text-[1.75rem]" : "text-[1.2rem]";
  const sub = size === "lg" ? "text-[0.62rem]" : "text-[0.48rem]";

  return (
    <span className="ltr inline-flex items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-mark.svg" alt="" aria-hidden className={`${markPx} w-auto`} />

      <span className="flex flex-col justify-center leading-none">
        <span className={`font-extrabold tracking-tight text-[var(--foreground)] ${euro}`}>
          EURO
        </span>
        <span
          className={`mt-[0.2em] font-semibold uppercase tracking-[0.14em] text-[var(--brand)] ${sub}`}
        >
          Tools &amp; Automation
        </span>
      </span>
    </span>
  );
}

/** The application's own name, worn beside the company's. */
function AppName({ size }: { size: "sm" | "lg" }) {
  return (
    <span
      className={`ms-3 border-s border-[var(--border-strong)] ps-3 font-extrabold tracking-tight text-[var(--brand)] ${
        size === "lg" ? "text-2xl" : "text-lg"
      }`}
    >
      QC
    </span>
  );
}

/** The mark on its own, for the sign-in page where there is nowhere to go. */
export function Brand({ size = "lg" }: { size?: "sm" | "lg" }) {
  return (
    <span className="inline-flex items-center" aria-label="QC — EURO Tools & Automation">
      <Mark size={size} />
      <AppName size={size} />
    </span>
  );
}

/** The mark as the way home, for the header. */
export function BrandLink() {
  return (
    <Link
      href="/"
      className="inline-flex items-center"
      aria-label="QC — EURO Tools & Automation"
    >
      <Mark size="sm" />
      <AppName size="sm" />
    </Link>
  );
}
