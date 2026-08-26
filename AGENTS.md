# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

Things that have already caught us out here:

- `params` and `searchParams` are **Promises**. Await them. Use the global
  `PageProps<'/route'>` / `LayoutProps` helpers (run `npx next typegen` if the
  types are missing).
- `revalidateTag` takes a **second argument** (a `cacheLife` profile). Prefer
  `updateTag` in Server Actions when the user must see their own write, and
  `refresh()` from `next/cache` to refresh the router.
- Turbopack is the default for `next dev` **and** `next build`.
- `next lint` is gone — the `lint` script calls the ESLint CLI directly.
- A `<form action={fn}>` requires `fn` to return `void`. Our server actions
  return an `ActionResult`, so they go through `ActionForm` / `InlineForm`,
  which surface the error or info line instead of throwing it away.

# Project conventions

- **`lib/domain/` is pure.** No I/O, no Prisma, no `server-only`. Every
  pass/fail rule lives there and has a test beside it. The same functions run
  in the browser (to preview a verdict) and on the server (to decide it) — if
  those two ever disagree, the inspector signs one thing and the database
  stores another.
- **`lib/domain/stages.ts` is the single source of truth for the checklists.**
  Add or reword an item there and the forms, reports and CSV export all follow.
  The database stores the item `key`, never the label, so re-wording a line
  must never change its key — that would orphan every historical answer.
- **`lib/server/` holds the Prisma access** and is `server-only`.
- Run `npm run test:run && npm run typecheck && npm run lint` before pushing.
