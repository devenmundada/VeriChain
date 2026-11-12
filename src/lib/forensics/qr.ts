/**
 * QR reading in the browser (zxing-wasm, wasm self-hosted in public/vendor/zxing).
 */

export interface QRHit {
  text: string;
  bytes: Uint8Array;
  /** pixel box in the canvas that was scanned */
  box: { x: number; y: number; w: number; h: number };
}

let prepared = false;

async function zxing() {
  const m = await import("zxing-wasm/reader");
  if (!prepared) {
    m.prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) =>
          path.endsWith(".wasm") ? "/vendor/zxing/zxing_reader.wasm" : prefix + path,
      },
    });
    prepared = true;
  }
  return m;
}

export async function readQRCodes(canvas: HTMLCanvasElement): Promise<QRHit[]> {
  const m = await zxing();
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const results = await m.readBarcodes(imageData, {
    formats: ["QRCode"],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    maxNumberOfSymbols: 4,
  });
  return results
    .filter((r) => r.isValid)
    .map((r) => {
      const p = r.position;
      const xs = [p.topLeft.x, p.topRight.x, p.bottomLeft.x, p.bottomRight.x];
      const ys = [p.topLeft.y, p.topRight.y, p.bottomLeft.y, p.bottomRight.y];
      const x = Math.min(...xs), y = Math.min(...ys);
      return {
        text: r.text,
        bytes: r.bytes,
        box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y },
      };
    });
}

/**
 * Phone photos: the dense Aadhaar QR is often a small part of a large frame.
 * Try the full image, a downscaled copy, then enlarged overlapping crops.
 */
export async function readQRCodesRobust(canvas: HTMLCanvasElement): Promise<QRHit[]> {
  let hits = await readQRCodes(canvas).catch(() => [] as QRHit[]);
  if (hits.length) return hits;
  const W = canvas.width, H = canvas.height;
  const attempts: { sx: number; sy: number; sw: number; sh: number; scale: number }[] = [];
  const longSide = Math.max(W, H);
  if (longSide > 1800) attempts.push({ sx: 0, sy: 0, sw: W, sh: H, scale: 1600 / longSide });
  for (const [fx, fy] of [[0, 0], [0.4, 0], [0, 0.4], [0.4, 0.4], [0.2, 0.2]]) {
    attempts.push({ sx: Math.round(W * fx), sy: Math.round(H * fy), sw: Math.round(W * 0.6), sh: Math.round(H * 0.6), scale: Math.min(2, 2000 / Math.max(W * 0.6, H * 0.6)) });
  }
  for (const a of attempts) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(a.sw * a.scale));
    c.height = Math.max(1, Math.round(a.sh * a.scale));
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, a.sx, a.sy, a.sw, a.sh, 0, 0, c.width, c.height);
    hits = await readQRCodes(c).catch(() => [] as QRHit[]);
    if (hits.length) {
      return hits.map((h) => ({
        ...h,
        box: { x: a.sx + h.box.x / a.scale, y: a.sy + h.box.y / a.scale, w: h.box.w / a.scale, h: h.box.h / a.scale },
      }));
    }
  }
  return [];
}
