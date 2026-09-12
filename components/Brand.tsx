import Link from "next/link";

/** The company mark, in one place.
 *
 *  Written as text rather than as an image so it follows the theme, stays
 *  sharp at any size, and needs no file to load before the header can render.
 *  When the real artwork is available, replace the markup inside `<Mark>` with
 *  an `<Image>` of it — every screen picks it up, because every screen asks
 *  for the mark here.
 *
 *  The blue is `--brand`. The red from the company mark is deliberately absent
 *  from the interface; see the note at the top of `globals.css` for why.
 */
function Mark({ size }: { size: "sm" | "lg" }) {
  const euro = size === "lg" ? "text-[1.6rem]" : "text-[1.15rem]";
  const sub = size === "lg" ? "text-[0.6rem]" : "text-[0.5rem]";

  return (
    <span className="ltr inline-flex items-center gap-2">
      <span
        aria-hidden
        className={`block w-[3px] self-stretch rounded-full bg-[var(--brand)] ${
          size === "lg" ? "min-h-[2.6rem]" : "min-h-[1.9rem]"
        }`}
      />
      <span className="flex flex-col justify-center leading-none">
        <span className={`font-extrabold tracking-tight text-[var(--brand)] ${euro}`}>EURO</span>
        <span
          className={`mt-[0.15em] font-semibold uppercase tracking-[0.18em] text-[var(--muted)] ${sub}`}
        >
          Tools &amp; Automation
        </span>
      </span>
    </span>
  );
}

/** The mark on its own, for the sign-in page where there is nowhere to go. */
export function Brand({ size = "lg" }: { size?: "sm" | "lg" }) {
  return (
    <span className="inline-flex items-center" aria-label="EURO Tools & Automation">
      <Mark size={size} />
    </span>
  );
}

/** The mark as the way home, for the header. */
export function BrandLink() {
  return (
    <Link href="/" className="inline-flex items-center" aria-label="EURO Tools & Automation">
      <Mark size="sm" />
    </Link>
  );
}
