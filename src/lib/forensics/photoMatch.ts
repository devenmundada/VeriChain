/**
 * Photo vs signed QR photo.
 *
 * The Aadhaar Secure QR (V2+) carries a small JPEG 2000 photo of the holder, signed by UIDAI
 * together with the name and date of birth. The card prints the same enrolment photo (a wider
 * crop). If the printed photo was swapped, it won't line up with the signed one.
 *
 * Method: both photos → grayscale, contrast-normalised. The QR photo is slid over the printed
 * photo at several sizes; the best normalised cross-correlation (of the pixels and of their
 * gradients) is the score. Same photo → ~0.9; a different person → well below 0.7.
 *
 * Pure functions (no DOM) so they can be unit-tested in Node.
 */

export interface Gray {
  w: number;
  h: number;
  d: Float32Array;
}

export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, channels = 4): Gray {
  const d = new Float32Array(w * h);
  for (let i = 0, j = 0; j < d.length; i += channels, j++) {
    d[j] = channels >= 3 ? 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2] : rgba[i];
  }
  return { w, h, d };
}

/** Area-average resize (good for shrinking), bilinear when enlarging. */
export function resize(g: Gray, W: number, H: number): Gray {
  const out = new Float32Array(W * H);
  const sx = g.w / W, sy = g.h / H;
  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < H; y++) {
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < W; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let s = 0, n = 0;
        for (let yy = y0; yy < Math.min(g.h, y1); yy++) for (let xx = x0; xx < Math.min(g.w, x1); xx++) { s += g.d[yy * g.w + xx]; n++; }
        out[y * W + x] = n ? s / n : 0;
      }
    }
  } else {
    for (let y = 0; y < H; y++) {
      const fy = Math.min(g.h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(g.h - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = Math.min(g.w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(g.w - 1, x0 + 1), tx = fx - x0;
        const a = g.d[y0 * g.w + x0], b = g.d[y0 * g.w + x1], c = g.d[y1 * g.w + x0], e = g.d[y1 * g.w + x1];
        out[y * W + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
      }
    }
  }
  return { w: W, h: H, d: out };
}

function gradient(g: Gray): Gray {
  const d = new Float32Array(g.w * g.h);
  for (let y = 1; y < g.h - 1; y++)
    for (let x = 1; x < g.w - 1; x++) {
      const i = y * g.w + x;
      const gx = g.d[i + 1] - g.d[i - 1], gy = g.d[i + g.w] - g.d[i - g.w];
      d[i] = Math.hypot(gx, gy);
    }
  return { w: g.w, h: g.h, d };
}

/** NCC of template t placed at (ox, oy) inside image g. */
function nccAt(g: Gray, t: Gray, ox: number, oy: number, tMean: number, tStd: number): number {
  let s = 0, s2 = 0, st = 0;
  const n = t.w * t.h;
  for (let y = 0; y < t.h; y++) {
    const gr = (oy + y) * g.w + ox, tr = y * t.w;
    for (let x = 0; x < t.w; x++) {
      const v = g.d[gr + x];
      s += v;
      s2 += v * v;
      st += v * t.d[tr + x];
    }
  }
  const mean = s / n;
  const std = Math.sqrt(Math.max(1e-6, s2 / n - mean * mean));
  return (st / n - mean * tMean) / (std * tStd);
}

function stats(t: Gray) {
  let s = 0, s2 = 0;
  for (const v of t.d) { s += v; s2 += v * v; }
  const mean = s / t.d.length;
  return { mean, std: Math.sqrt(Math.max(1e-6, s2 / t.d.length - mean * mean)) };
}

export interface PhotoMatch {
  /** combined score 0..1 (pixels + gradients), best over sizes and positions */
  score: number;
  pixel: number;
  edges: number;
  /** where the QR photo lined up inside the printed photo (0..1 of its width/height) */
  at: { x: number; y: number; w: number; h: number };
}

/**
 * Best alignment of the QR photo (template) inside the printed photo.
 * The QR photo is usually a tighter, square crop of the face; the printed one is wider.
 */
export function matchPhotos(printed: Gray, qr: Gray, opts: { minFrac?: number; maxFrac?: number; width?: number } = {}): PhotoMatch {
  const PW = opts.width ?? 64;
  const PH = Math.max(16, Math.round((PW * printed.h) / printed.w));
  const P = resize(printed, PW, PH);
  const PG = gradient(P);
  let best: PhotoMatch = { score: -1, pixel: -1, edges: -1, at: { x: 0, y: 0, w: 0, h: 0 } };
  const aspect = qr.h / qr.w;
  const step = PW > 80 ? 3 : 2;
  for (let tw = Math.max(12, Math.round(PW * (opts.minFrac ?? 0.4))); tw <= Math.round(PW * (opts.maxFrac ?? 1)); tw += step) {
    const th = Math.round(tw * aspect);
    if (th > PH || th < 12) continue;
    const T = resize(qr, tw, th);
    const TG = gradient(T);
    const ts = stats(T), tgs = stats(TG);
    const stride = PW > 80 ? 2 : 1;
    for (let oy = 0; oy + th <= PH; oy += stride) {
      for (let ox = 0; ox + tw <= PW; ox += stride) {
        const p = nccAt(P, T, ox, oy, ts.mean, ts.std);
        if (p < best.pixel - 0.25) continue;
        const e = nccAt(PG, TG, ox, oy, tgs.mean, tgs.std);
        const sc = 0.5 * p + 0.5 * e;
        if (sc > best.score) best = { score: sc, pixel: p, edges: e, at: { x: ox / PW, y: oy / PH, w: tw / PW, h: th / PH } };
      }
    }
  }
  return best;
}

/** Locate the JPEG 2000 photo inside a decompressed Secure QR payload. */
export function findQrPhoto(raw: Uint8Array): Uint8Array | null {
  // J2K codestream: FF 4F FF 51 … FF D9. (JP2 file box variant: 00 00 00 0C 6A 50 20 20.)
  for (let i = 0; i + 4 < raw.length; i++) {
    const j2k = raw[i] === 0xff && raw[i + 1] === 0x4f && raw[i + 2] === 0xff && raw[i + 3] === 0x51;
    const jp2 = raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 0 && raw[i + 3] === 0x0c && raw[i + 4] === 0x6a && raw[i + 5] === 0x50;
    if (!j2k && !jp2) continue;
    // compressed J2K data never contains FF followed by a byte ≥ 0x90, so the first FF D9 is the end
    let end = -1;
    for (let k = i + 4; k + 1 < raw.length; k++) if (raw[k] === 0xff && raw[k + 1] === 0xd9) { end = k + 2; break; }
    if (end < 0 || end - i < 100) return null;
    return raw.slice(i, end);
  }
  return null;
}
