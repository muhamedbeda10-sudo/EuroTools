"use client";
import { Megaphone } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";

type Lang = "en" | "ar";
const LANG_KEY = "egx-news-lang";
const day = (iso: string, lang: Lang) => new Date(`${iso}T12:00:00`).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", { day: "numeric", month: "long", year: "numeric" });

/** What's new: the app's release notes (backend/app/knowledge/whats-new.md, which the assistant reads too).
 *
 *  After an update the list opens by itself, once, with what this person has not seen. It is always in the menu.
 *  Closing it marks what was shown as seen, for this person on all their devices.
 */
export default function WhatsNew() {
  const { data, reload } = useApi("/api/v1/whats-new");
  const dialog = useRef<HTMLDialogElement>(null);
  const offered = useRef(false);
  const [onlyNew, setOnlyNew] = useState(false);
  const [lang, setLang] = useState<Lang>("en");

  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(LANG_KEY); } catch {}
    setLang(saved === "ar" || saved === "en" ? saved : navigator.language?.toLowerCase().startsWith("ar") ? "ar" : "en");
  }, []);
  // An update arrived since this person last looked: show it once, without being asked.
  useEffect(() => {
    if (!data || offered.current || data.unseen === 0) return;
    offered.current = true;
    setOnlyNew(true);
    dialog.current?.showModal();
  }, [data]);

  if (!data || !data.releases.length) return null;
  const speak = (next: Lang) => { setLang(next); try { localStorage.setItem(LANG_KEY, next); } catch {} };
  const show = () => { setOnlyNew(false); dialog.current?.showModal(); };
  const closed = async () => {
    if (data.unseen > 0 && data.latest) {
      try { await api("/api/v1/whats-new/seen", { method: "POST", json: { id: data.latest } }); } catch { /* it is shown again next time */ }
      reload();
    }
  };
  const listed = onlyNew ? data.releases.filter((r: any) => r.new) : data.releases;
  const ar = lang === "ar";
  return (
    <>
      <button type="button" className="nav-btn" onClick={show}>
        <Megaphone size={16} aria-hidden="true" />What&apos;s new
        {data.unseen > 0 && <span className="nav-count" title="Updates you have not seen yet">{data.unseen}<span className="sr-only"> updates you have not seen yet</span></span>}
      </button>
      {createPortal(
        <dialog ref={dialog} className="sheet news" aria-labelledby="news-title" onClose={closed}
          onClick={(e) => { if (e.target === dialog.current) dialog.current?.close(); }}>
          <div className="news-head">
            <h2 id="news-title">{ar ? "الجديد في التطبيق" : "What’s new"}</h2>
            <div className="seg" role="group" aria-label="Language">
              <button type="button" className={!ar ? "on" : ""} aria-pressed={!ar} onClick={() => speak("en")}>English</button>
              <button type="button" className={ar ? "on" : ""} aria-pressed={ar} onClick={() => speak("ar")} lang="ar">عربي</button>
            </div>
          </div>
          <div dir={ar ? "rtl" : "ltr"} lang={lang} className="news-body">
            {listed.map((r: any) => (
              <article key={r.id}>
                <p className="news-when"><span className="num">{ar ? `إصدار ${r.version}` : `Version ${r.version}`}</span> · {day(r.date, lang)}
                  {r.new && !onlyNew && <span className="badge paper">{ar ? "جديد" : "new"}</span>}</p>
                <h3>{r.title[lang]}</h3>
                <ul>{r.points.map((p: any) => <li key={p.en}>{p[lang]}</li>)}</ul>
                {r.where && <Link href={r.where} onClick={() => dialog.current?.close()}>{ar ? "افتحها" : "Open it"}</Link>}
              </article>
            ))}
          </div>
          <div className="form-actions news-foot">
            <button type="button" className="primary" onClick={() => dialog.current?.close()}>{ar ? "تمام" : "Got it"}</button>
            {onlyNew && data.releases.length > listed.length && <button type="button" onClick={() => setOnlyNew(false)}>{ar ? "كل التحديثات" : "Earlier updates"}</button>}
            <span className="muted num" style={{ marginInlineStart: "auto", fontSize: 12 }}>EGX Intelligence {data.version}</span>
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
