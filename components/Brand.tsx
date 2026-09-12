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
  const height = size === "lg" ? "h-11" : "h-8";
  const wordHeight = size === "lg" ? "h-10" : "h-7";

  return (
    <span className="ltr inline-flex items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-mark.svg" alt="" aria-hidden className={`${height} w-auto`} />

      {/* Both lines are forced to the same width, the way the company sets its
          own mark: EURO and the line beneath it share an edge on each side, so
          the block reads as one thing rather than as a word with a caption.
          
          SVG rather than CSS because CSS cannot do it. `text-align: justify`
          distributes space between *words*, and EURO is one word with nothing
          to distribute; `textLength` states the width outright and
          `lengthAdjust="spacing"` reaches it by opening the letters rather
          than stretching their shapes. */}
      <svg
        viewBox="0 0 144 60"
        className={`${wordHeight} w-auto`}
        role="img"
        aria-label="EURO Tools & Automation"
      >
        <text
          x="0"
          y="40"
          textLength="144"
          lengthAdjust="spacing"
          fontFamily="inherit"
          fontSize="46"
          fontWeight="800"
          fill="var(--foreground)"
        >
          EURO
        </text>
        {/* Mixed case, as the company sets it. All caps here would be half as
            wide again and force EURO open to meet it. */}
        <text
          x="0"
          y="57"
          textLength="144"
          lengthAdjust="spacing"
          fontFamily="inherit"
          fontSize="14.5"
          fontWeight="600"
          fill="var(--brand)"
        >
          Tools &amp; Automation
        </text>
      </svg>
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
