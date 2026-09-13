"use client";

import { useRef, useState } from "react";

import { PlusIcon, TrashIcon } from "./icons";
import { PHOTO_MAX_PER_INSPECTION } from "@/lib/model";

/** Camera or gallery, both from inside the page.
 *
 *  Two inputs rather than one, because `capture` is not a choice a browser
 *  offers afterwards: an input carrying it opens the camera and an input
 *  without it opens the picker. One control cannot do both, so there are two
 *  buttons and one hidden input behind each.
 *
 *  Files accumulate rather than replace. Picking a second photograph with a
 *  single input throws the first away, which is not what anybody means by
 *  taking another one.
 */
export function PhotoField() {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const carrier = useRef<HTMLInputElement>(null);
  const [shots, setShots] = useState<{ url: string; name: string; file: File }[]>([]);

  /** The input the form actually posts. Kept in step with the previews by a
   *  DataTransfer, which is the only way to put a chosen file back into an
   *  input element. */
  function republish(next: { url: string; name: string; file: File }[]) {
    const bag = new DataTransfer();
    for (const s of next) bag.items.add(s.file);
    if (carrier.current) carrier.current.files = bag.files;
    setShots(next);
  }

  function add(files: FileList | null) {
    const chosen = Array.from(files ?? []);
    if (chosen.length === 0) return;

    const next = [...shots];
    for (const file of chosen) {
      if (next.length >= PHOTO_MAX_PER_INSPECTION) break;
      next.push({ url: URL.createObjectURL(file), name: file.name, file });
    }
    republish(next);

    // So the same file can be chosen twice in a row.
    if (camera.current) camera.current.value = "";
    if (gallery.current) gallery.current.value = "";
  }

  function remove(url: string) {
    URL.revokeObjectURL(url);
    republish(shots.filter((s) => s.url !== url));
  }

  const full = shots.length >= PHOTO_MAX_PER_INSPECTION;

  return (
    <div className="mt-3">
      <p className="label">Photographs</p>

      <input ref={carrier} name="photos" type="file" multiple className="hidden" />
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => add(e.target.files)}
      />
      <input
        ref={gallery}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => add(e.target.files)}
      />

      <div className="no-print flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn"
          disabled={full}
          onClick={() => camera.current?.click()}
        >
          <CameraIcon /> Camera
        </button>
        <button
          type="button"
          className="btn"
          disabled={full}
          onClick={() => gallery.current?.click()}
        >
          <PlusIcon /> Upload
        </button>
        <span className="text-xs text-[var(--muted)]">
          {shots.length}/{PHOTO_MAX_PER_INSPECTION}
        </span>
      </div>

      {shots.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {shots.map((s) => (
            <span key={s.url} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.url}
                alt={s.name}
                className="h-20 w-20 rounded-[var(--radius-sm)] border border-[var(--border)] object-cover"
              />
              <button
                type="button"
                className="btn btn-icon absolute -end-2 -top-2 h-7 w-7 min-h-0 rounded-full"
                aria-label={`Remove ${s.name}`}
                onClick={() => remove(s.url)}
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CameraIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[1.15em] w-[1.15em]"
      aria-hidden
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
