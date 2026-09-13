"use client";

import { CloseIcon, SearchIcon } from "./icons";

/** One dropdown's worth of a filter: what to call it, what it can be, and
 *  where its current value lives. */
export interface Facet {
  key: string;
  label: string;
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
  /** How to label an option, where the stored value is not what to show. */
  format?: (value: string) => string;
}

/** The bar above a list: a search box, some dropdowns, and a count.
 *
 *  The count is not decoration. A filter that hides rows without saying how
 *  many is how somebody concludes a project has no work left when what
 *  actually happened is that a dropdown two screens ago is still set.
 */
export function FilterBar({
  query,
  onQuery,
  facets = [],
  showing,
  total,
  placeholder = "Search…",
  noun = "row",
}: {
  query: string;
  onQuery: (value: string) => void;
  facets?: Facet[];
  showing: number;
  total: number;
  placeholder?: string;
  noun?: string;
}) {
  const active = query.trim() !== "" || facets.some((f) => f.value !== "");

  function clear() {
    onQuery("");
    for (const f of facets) f.onChange("");
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <label className="relative min-w-0 flex-1 basis-56">
        <span className="sr-only">{placeholder}</span>
        <SearchIcon className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]" />
        <input
          className="input w-full ps-9"
          type="search"
          value={query}
          placeholder={placeholder}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>

      {facets.map((facet) => (
        <label key={facet.key} className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-[var(--muted)]">{facet.label}</span>
          <select
            className="select"
            value={facet.value}
            onChange={(e) => facet.onChange(e.target.value)}
          >
            <option value="">Any</option>
            {facet.options.map((o) => (
              <option key={o} value={o}>
                {facet.format ? facet.format(o) : o}
              </option>
            ))}
          </select>
        </label>
      ))}

      {active && (
        <button type="button" className="btn" onClick={clear}>
          <CloseIcon className="h-4 w-4" /> Clear
        </button>
      )}

      <span className="num ms-auto text-xs text-[var(--muted)]">
        {active ? `${showing} of ${total}` : `${total}`} {total === 1 ? noun : `${noun}s`}
      </span>
    </div>
  );
}
