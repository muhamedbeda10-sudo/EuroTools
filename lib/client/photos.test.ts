import { describe, expect, it } from "vitest";

import { encodedBytes, fitWithin } from "./photos";
import { PHOTO_MAX_BYTES, PHOTO_MAX_EDGE, THUMB_MAX_EDGE } from "@/lib/model";

describe("fitting a camera photograph into what the database will hold", () => {
  it("caps the long edge and keeps the shape", () => {
    // What a tablet camera actually hands over, landscape and portrait.
    expect(fitWithin(4032, 3024, PHOTO_MAX_EDGE)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, PHOTO_MAX_EDGE)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(4032, 3024, THUMB_MAX_EDGE)).toEqual({ width: 320, height: 240 });
  });

  it("leaves a picture that is already small alone", () => {
    // Enlarging shows nothing more and costs more to store.
    expect(fitWithin(800, 600, PHOTO_MAX_EDGE)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1600, 1200, PHOTO_MAX_EDGE)).toEqual({ width: 1600, height: 1200 });
  });

  it("never produces a zero edge, which a canvas refuses to be", () => {
    // A panorama is the case that rounds a short edge away.
    const wide = fitWithin(8000, 120, THUMB_MAX_EDGE);
    expect(wide.width).toBe(320);
    expect(wide.height).toBeGreaterThanOrEqual(1);

    expect(fitWithin(0, 0, PHOTO_MAX_EDGE)).toEqual({ width: 0, height: 0 });
  });

  it("holds the shape to within a pixel", () => {
    const { width, height } = fitWithin(4032, 3024, PHOTO_MAX_EDGE);
    expect(Math.abs(width / height - 4032 / 3024)).toBeLessThan(0.01);
  });
});

describe("measuring what Firestore will actually count", () => {
  it("measures the encoded string, not the picture behind it", () => {
    // Base64 is a third larger than what it encodes, and the database stores
    // the string. Checking the file size would pass documents it then refuses.
    const dataUrl = `data:image/jpeg;base64,${"A".repeat(1000)}`;
    expect(encodedBytes(dataUrl)).toBe(dataUrl.length);
  });

  it("counts bytes rather than characters", () => {
    expect(encodedBytes("é")).toBe(2);
  });

  it("leaves room under the document limit for the fields beside it", () => {
    // Firestore refuses a document over 1 MiB, and a refusal would take the
    // inspection written in the same batch down with it.
    expect(PHOTO_MAX_BYTES).toBeLessThan(1_048_576 * 0.9);
  });
});
