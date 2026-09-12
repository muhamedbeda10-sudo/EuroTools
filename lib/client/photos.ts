"use client";

import { PHOTO_MAX_EDGE, PHOTO_MAX_BYTES, THUMB_MAX_EDGE } from "@/lib/model";

/** Turning what a phone camera produces into something a database can hold.
 *
 *  A shop-floor tablet takes a four-megabyte photograph. Firestore will not
 *  accept a document over a megabyte, and this plan allows one gigabyte in
 *  total, so the picture is resized and re-encoded in the browser before it
 *  goes anywhere. Doing it here rather than on arrival also means the tablet
 *  uploads a fifth of a megabyte over factory wifi instead of four.
 *
 *  Two sizes come out of one file: a thumbnail a gallery can list many of, and
 *  a full picture somebody opens one of. `lib/model.ts` explains why those are
 *  stored apart.
 */

export interface Prepared {
  thumb: string;
  data: string;
  width: number;
  height: number;
  bytes: number;
}

/** The size an image becomes when its long edge is capped.
 *
 *  Never enlarges: a photograph already smaller than the cap is left at its
 *  own size rather than blown up into a bigger file that shows no more.
 *  Rounds to whole pixels and never to zero, because a canvas of zero width
 *  throws rather than producing an empty image.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };

  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The byte length a base64 data URL actually occupies.
 *
 *  Firestore counts the string, not the picture, and base64 is a third larger
 *  than what it encodes. A size check against the file the camera produced
 *  would pass things the database then refuses.
 */
export function encodedBytes(dataUrl: string): number {
  return new TextEncoder().encode(dataUrl).length;
}

/** Re-encode at descending quality until it fits, or give up honestly.
 *
 *  A photograph of a machined surface is mostly fine detail, which JPEG
 *  compresses badly, so one fixed quality setting either bloats every picture
 *  or ruins the ones that matter. Stepping down only as far as needed keeps
 *  the usual photograph sharp and still gets an awkward one under the limit.
 */
function encodeWithinBudget(canvas: HTMLCanvasElement, budget: number): string {
  const qualities = [0.82, 0.72, 0.62, 0.5, 0.4];

  let encoded = canvas.toDataURL("image/jpeg", qualities[0]);
  for (const quality of qualities.slice(1)) {
    if (encodedBytes(encoded) <= budget) return encoded;
    encoded = canvas.toDataURL("image/jpeg", quality);
  }
  return encoded;
}

function draw(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot process images.");

  // White rather than transparent: a JPEG has no alpha channel, and a
  // transparent corner would otherwise come out black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

function load(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That image could not be read."));
    };
    image.src = url;
  });
}

/** One camera file, ready to store. What it throws is shown to whoever is
 *  holding the tablet, so it says what to do rather than what went wrong. */
export async function prepare(file: File): Promise<Prepared> {
  if (!file.type.startsWith("image/")) throw new Error("That file is not an image.");

  const image = await load(file);
  const full = fitWithin(image.naturalWidth, image.naturalHeight, PHOTO_MAX_EDGE);
  const data = encodeWithinBudget(draw(image, full.width, full.height), PHOTO_MAX_BYTES);

  if (encodedBytes(data) > PHOTO_MAX_BYTES)
    throw new Error("Still too large after compression. Try a closer or less detailed shot.");

  const small = fitWithin(image.naturalWidth, image.naturalHeight, THUMB_MAX_EDGE);
  const thumb = draw(image, small.width, small.height).toDataURL("image/jpeg", 0.6);

  return { thumb, data, width: full.width, height: full.height, bytes: encodedBytes(data) };
}
