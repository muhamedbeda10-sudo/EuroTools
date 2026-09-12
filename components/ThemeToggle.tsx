"use client";

/** The icon is chosen by CSS from the `dark` class on <html>, not by React
 *  state — the class is already set by the pre-paint script in the layout, so
 *  holding it in state would mean an extra render and a hydration mismatch to
 *  work around. */
export function ThemeToggle() {
  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      // private mode — the choice just does not persist
    }
  }

  return (
    <button type="button" className="btn" onClick={toggle} aria-label="Toggle theme">
      <span className="theme-icon-light" aria-hidden>
        ☾
      </span>
      <span className="theme-icon-dark" aria-hidden>
        ☀︎
      </span>
    </button>
  );
}
