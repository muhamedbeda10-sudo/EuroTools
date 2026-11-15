import type { NextConfig } from "next";

// Static export: the UI is plain files; the API is the Python function under /api.
const nextConfig: NextConfig = { output: "export", images: { unoptimized: true } };
export default nextConfig;
