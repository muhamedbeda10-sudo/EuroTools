/** Narrowing a list down to the rows somebody is actually looking at.
 *
 *  This is presentation, not a business rule — nothing here decides whether a
 *  piece passes. It lives on its own and stays pure for the same reason the
 *  domain rules do: a filter that quietly drops a row is a piece of work
 *  somebody stops seeing, and that is worth a test rather than a read-through.
 *
 *  Everything filters in the browser, over rows already fetched. That is a
 *  deliberate trade: a Firestore query per keystroke would be a read per
 *  keystroke, and the daily allowance is 50,000 of them. The lists these
 *  filter are bounded by the page's own query limits, so there is nothing here
 *  that grows without bound.
 */

/** Free-text search across whatever a row can be recognised by.
 *
 *  Every whitespace-separated term has to match something. Typing more words
 *  therefore narrows the list, which is what a person expects from a search
 *  box; an OR would widen it and feel broken. Matching is case-insensitive and
 *  on substrings, so half a project number finds the project.
 */
export function matchesText(
  fields: readonly (string | number | null | undefined)[],
  query: string
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = fields
    .filter((f) => f !== null && f !== undefined && f !== "")
    .map((f) => String(f).toLowerCase())
    .join(" ");

  return terms.every((term) => haystack.includes(term));
}

/** A facet matches when nothing is chosen, or when the row carries the chosen
 *  value. An empty choice means "any", never "blank". */
export function matchesFacet(value: string | null | undefined, chosen: string): boolean {
  if (chosen === "") return true;
  return (value ?? "") === chosen;
}

/** The values a facet can actually take, sorted, with blanks dropped.
 *
 *  Built from the rows in hand rather than from a fixed list, so the dropdown
 *  never offers a priority nobody used — an option that returns nothing is a
 *  dead end somebody has to back out of.
 */
export function facetValues<T>(
  rows: readonly T[],
  pick: (row: T) => string | null | undefined
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = pick(row)?.trim();
    if (value) seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
