"use client";

import { useEffect, useState } from "react";

import { useAsync } from "@/lib/client/use-async";

import { getInspectionPhotos, getPhotoData } from "@/lib/client/queries";
import { fmtDateTime } from "@/lib/format";

/** The photographs filed with one inspection.
 *
 *  Thumbnails are read with the traveller; a full picture is read only when
 *  somebody opens it. That split is the whole reason the pictures are stored
 *  as two documents — see `lib/model.ts`. A traveller with a dozen inspections
 *  on it therefore costs a few kilobytes of thumbnails, not a dozen megabytes
 *  of photographs nobody asked to see.
 */
export function PhotoGallery({ inspectionId }: { inspectionId: string }) {
  const [open, setOpen] = useState<string | null>(null);

  // `useAsync` derives its loading state rather than storing it, which is what
  // keeps both of these out of an effect that sets state on every render.
  const list = useAsync(() => getInspectionPhotos(inspectionId), [inspectionId]);
  const full = useAsync(
    () => (open ? getPhotoData(inspectionId, open) : Promise.resolve(null)),
    [inspectionId, open]
  );
  const photos = list.data ?? [];

  // Escape closes, because a gloved hand misses a small button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (photos.length === 0) return null;

  const current = photos.find((p) => p.id === open);

  return (
    <div className="mt-3">
      <p className="label">صور العيب</p>

      <div className="flex flex-wrap gap-2">
        {photos.map((photo) => (
          <button
            key={photo.id}
            type="button"
            onClick={() => setOpen(photo.id)}
            className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] transition hover:border-[var(--brand)]"
            title={`${photo.capturedByName} · ${fmtDateTime(photo.capturedAt)}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.thumb}
              alt={`صورة عيب — ${photo.capturedByName}`}
              className="h-20 w-20 object-cover"
              loading="lazy"
            />
          </button>
        ))}
      </div>

      {current && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="صورة العيب"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-4"
          onClick={() => setOpen(null)}
        >
          {full.data ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={full.data}
              alt={`صورة عيب — ${current.capturedByName}`}
              className="max-h-[80vh] max-w-full rounded-[var(--radius)] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <p className="text-sm text-white">…جارٍ التحميل</p>
          )}

          <p className="text-center text-xs text-white/80">
            {current.capturedByName} · {fmtDateTime(current.capturedAt)}
            <br />
            اضغط في أي مكان للإغلاق
          </p>
        </div>
      )}
    </div>
  );
}
