import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "./globals.css";
import Shell from "@/components/Shell";

export const metadata: Metadata = {
  title: "EGX Intelligence",
  description: "Personal EGX market analysis and paper-trading workspace",
  // What a phone needs to install the app on its home screen (public/manifest.webmanifest, public/icons).
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }, { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: { capable: true, title: "EGX", statusBarStyle: "default" },
  formatDetection: { telephone: false },   // a price is not a phone number
};

// The colour of the phone's status bar: the top bar's own, in each theme. The shell keeps it in step with the theme switch.
export const viewport: Viewport = {
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#ffffff" }, { media: "(prefers-color-scheme: dark)", color: "#11151c" }],
};

const themeScript = `try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
