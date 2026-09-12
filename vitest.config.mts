import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // `lib/server/*` opens with `import "server-only"`, a marker package that
      // throws unless the importer is a Server Component. Next.js satisfies it
      // with a resolution condition; under Vitest the module is loaded as
      // CommonJS, where that condition does not apply, so it is pointed at the
      // package's own empty build instead. That is the same file Next.js
      // resolves to — the marker is being honoured, not bypassed.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "components/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
