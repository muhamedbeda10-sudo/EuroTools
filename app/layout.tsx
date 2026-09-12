import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";
import { AppNav } from "@/components/AppNav";
import { SessionProvider } from "@/lib/client/session";

const cairo = Cairo({
  variable: "--font-sans-arabic",
  subsets: ["arabic", "latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "EURO Tools — فحص الجودة",
  description:
    "من استلام الخامة حتى الإفراج النهائي: تحليل، فحص بعد الخشونة، المعالجة الحرارية، التجليخ، والفحص النهائي مع CMM.",
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
    <html lang="ar" dir="rtl" className={`${cairo.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="flex min-h-full flex-col antialiased">
        {/* The session is resolved once here and read by every page and by the
            navigation, rather than each of them asking Firebase separately. */}
        <SessionProvider>
          <AppNav />
          <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 md:px-6 md:py-6">
            {children}
          </main>
        </SessionProvider>
      </body>
    </html>
  );
}
