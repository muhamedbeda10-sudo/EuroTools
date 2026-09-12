"use client";

import { useRef, useState } from "react";

import { PHOTO_MAX_PER_INSPECTION } from "@/lib/model";

/** Photographing a defect, from the sheet that records it.
 *
 *  `capture="environment"` is what makes a tablet open its rear camera rather
 *  than a file browser, which is the whole difference between an inspector
 *  taking a photograph and an inspector deciding not to bother.
 *
 *  The chosen files stay in the input and are posted with the rest of the
 *  sheet — the resizing and the writing happen in the action, in the same
 *  transaction as the verdict. Nothing is stored until the sheet is signed, so
 *  abandoning a half-filled form leaves nothing behind.
 */
export function PhotoField() {
  const input = useRef<HTMLInputElement>(null);
  const [previews, setPreviews] = useState<{ url: string; name: string }[]>([]);
  const [tooMany, setTooMany] = useState(false);

  function choose(files: FileList | null) {
    // Revoking first: each preview holds a blob alive until it is let go.
    for (const p of previews) URL.revokeObjectURL(p.url);

    const chosen = Array.from(files ?? []);
    setTooMany(chosen.length > PHOTO_MAX_PER_INSPECTION);
    setPreviews(
      chosen
        .slice(0, PHOTO_MAX_PER_INSPECTION)
        .map((f) => ({ url: URL.createObjectURL(f), name: f.name }))
    );
  }

  function clear() {
    for (const p of previews) URL.revokeObjectURL(p.url);
    setPreviews([]);
    setTooMany(false);
    if (input.current) input.current.value = "";
  }

  return (
    <div className="mt-3">
      <label className="label" htmlFor="photos">
        صور العيب (اختياري)
      </label>

      <input
        ref={input}
        id="photos"
        name="photos"
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="input"
        onChange={(e) => choose(e.target.files)}
      />

      <p className="mt-1 text-xs text-[var(--muted)]">
        حتى {PHOTO_MAX_PER_INSPECTION} صور. تُصغَّر على الجهاز قبل الرفع، وتُحفظ
        مع الفحص ولا يمكن تغييرها أو حذفها بعد التوقيع.
      </p>

      {tooMany && (
        <p className="mt-1 text-xs font-semibold text-[var(--bad-fg)]">
          اخترت أكثر من {PHOTO_MAX_PER_INSPECTION} صور — سيُرفَض الحفظ. امسح
          الاختيار وأعد اختيار {PHOTO_MAX_PER_INSPECTION} على الأكثر.
        </p>
      )}

      {previews.length > 0 && (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          {previews.map((p) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={p.url}
              src={p.url}
              alt={p.name}
              className="h-20 w-20 rounded-[var(--radius-sm)] border border-[var(--border)] object-cover"
            />
          ))}
          <button type="button" className="btn" onClick={clear}>
            مسح الصور
          </button>
        </div>
      )}
    </div>
  );
}
