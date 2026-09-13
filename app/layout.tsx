import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppNav } from "@/components/AppNav";
import { InstallPrompt } from "@/components/InstallPrompt";
import { SessionProvider } from "@/lib/client/session";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "QC — EURO Tools & Automation",
  applicationName: "QC",
  manifest: "/manifest.webmanifest",
  // Naming any icon here replaces the set Next.js builds from `app/icon.svg`,
  // so the tab icon has to be named too — otherwise the browser finds no icon
  // link at all and falls back to probing /favicon.ico, which does not exist.
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  // iOS has no install event; this is what makes Add to Home Screen open the
  // application full screen instead of inside Safari's chrome.
  appleWebApp: { capable: true, title: "QC", statusBarStyle: "black-translucent" },
  description:
    "From goods-in to final release: material analysis, post-roughing, heat treatment, post-grinding and final inspection with CMM.",
};

/** `viewportFit: "cover"` lets the page reach under a phone's rounded corners
 *  and notch; the padding that keeps content clear of them is in `globals.css`.
 *  Zoom is deliberately not capped — a shop-floor tablet gets read through
 *  safety glasses. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1218" },
  ],
};

// Applied before paint so there is no light/dark flash on load.
//
// Dark is the default, and light is chosen rather than inherited. A tablet on
// the shop floor is looked at for a whole shift, and which theme the factory
// sees should not depend on a setting somebody left on the device.
const themeInit = `(function(){try{if(localStorage.getItem("theme")!=="light"){document.documentElement.classList.add("dark")}}catch(e){document.documentElement.classList.add("dark")}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" dir="ltr" className={`${inter.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="flex min-h-full flex-col antialiased">
        {/* The session is resolved once here and read by every page and by the
            navigation, rather than each of them asking Firebase separately. */}
        <SessionProvider>
          <AppNav />
          <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 md:px-6 md:py-6 2xl:max-w-[1720px]">
            {children}
          </main>
          <InstallPrompt />
        </SessionProvider>
      </body>
    </html>
  );
}
