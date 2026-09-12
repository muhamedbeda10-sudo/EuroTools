import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** A static site, because that is what Firebase Hosting serves on the
   *  no-cost plan. Every page renders in the browser and talks to Firestore
   *  directly; there is no server process anywhere in production.
   *
   *  Two consequences worth knowing before adding anything:
   *
   *  - A dynamic route needs its ids at build time, which a plant's part
   *    numbers obviously are not. The detail pages are static routes reading
   *    an id from the query string instead — `/parts/view?id=…`.
   *  - Route handlers and Server Actions do not exist. The CSV export is built
   *    in the page, and every write goes through `lib/client/actions.ts`.
   *
   *  The security headers that used to be set here are served by Firebase
   *  Hosting now; see the `headers` block in firebase.json.
   */
  output: "export",

  // Firebase Hosting serves `/parts/view` from `/parts/view/index.html`, so the
  // trailing-slash form is what the exported tree should produce.
  trailingSlash: true,

  images: { unoptimized: true },
};

export default nextConfig;
