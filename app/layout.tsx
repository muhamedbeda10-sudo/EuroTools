import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";
import { AppNav } from "@/components/AppNav";

const cairo = Cairo({
  variable: "--font-sans-arabic",
  subsets: ["arabic", "latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "فحص الجودة — Quality Inspection",
  description:
    "من استلام الخامة حتى الإفراج النهائي: تحليل، فحص بعد الخشونة، المعالجة الحرارية، التجليخ، والفحص النهائي مع CMM.",
};

// Applied before paint so there is no light/dark flash on load.
const themeInit = `(function(){try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" className={`${cairo.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="flex min-h-full flex-col antialiased">
        <AppNav />
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 md:px-6 md:py-6">
          {children}
        </main>
      </body>
    </html>
  );
}
