/**
 * Image metadata checks: editing software, edit dates, and the embedded
 * EXIF preview thumbnail — many editors change the picture but forget to
 * regenerate the preview, so the preview is a small copy of the original.
 */

import { type CheckRun, type Evidence, type TamperLayer, TamperGrid } from "./types";

export const IMAGE_EDITOR_RE =
  /photoshop|gimp|picsart|snapseed|lightroom|canva|pixlr|paint\.net|affinity|fotor|photopea|inshot|remini|polarr|meitu|vsco|facetune|picmonkey|befunky|krita|corel|paintshop|ms ?paint|microsoft paint|photo ?editor|photoroom|lensa|picsart|airbrush|ibis|procreate|pixelmator|acdsee|luminar|capture one|darktable|rawtherapee|preview/i;

export interface ExifSummary {
  hasExif: boolean;
  software?: string;
  camera?: string;
  dateTaken?: string;
  dateModified?: string;
}

export interface ExifAnalysis {
  summary: ExifSummary;
  evidence: Evidence[];
  layers: TamperLayer[];
  checks: CheckRun[];
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v === "string") {
    const d = new Date(v.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export async function analyzeExif(file: Blob, canvas: HTMLCanvasElement, grid: TamperGrid): Promise<ExifAnalysis> {
  const evidence: Evidence[] = [];
  const layers: TamperLayer[] = [];
  const checks: CheckRun[] = [];
  let eid = 0;
  const ev = (e: Omit<Evidence, "id">) => evidence.push({ id: `exif-${eid++}`, ...e });
  const summary: ExifSummary = { hasExif: false };

  const exifr = (await import("exifr")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tags: Record<string, any> | undefined;
  try {
    tags = await exifr.parse(file, { tiff: true, exif: true, xmp: true, iptc: true, ifd1: true, gps: false, icc: false, mergeOutput: true });
  } catch {
    tags = undefined;
  }

  if (tags && Object.keys(tags).length) {
    summary.hasExif = true;
    const tools = [tags.Software, tags.CreatorTool, tags.ProcessingSoftware, tags.HistorySoftwareAgent, tags.OriginatingProgram]
      .flat()
      .filter((t) => typeof t === "string") as string[];
    summary.software = tools[0];
    summary.camera = [tags.Make, tags.Model].filter(Boolean).join(" ") || undefined;
    const taken = asDate(tags.DateTimeOriginal ?? tags.CreateDate);
    const modified = asDate(tags.ModifyDate);
    summary.dateTaken = taken?.toISOString();
    summary.dateModified = modified?.toISOString();

    const editor = tools.find((t) => IMAGE_EDITOR_RE.test(t));
    if (editor) {
      ev({
        category: "metadata",
        severity: "warning",
        title: "Opened in an image editor",
        detail: `The file says it was last saved by "${editor}". A photo or scan of a document has no reason to pass through an editor.`,
      });
    }
    if (taken && modified && modified.getTime() - taken.getTime() > 5 * 60 * 1000) {
      ev({
        category: "metadata",
        severity: "info",
        title: "Saved again after it was taken",
        detail: `Taken ${taken.toLocaleString()}, saved again ${modified.toLocaleString()}.`,
      });
    }
    checks.push({ id: "exif", label: "Image metadata", status: editor ? "flag" : "pass", note: summary.camera || summary.software });
  } else {
    checks.push({ id: "exif", label: "Image metadata", status: "skip", note: "no metadata (stripped, screenshot or forwarded)" });
  }

  // ── Embedded preview vs the picture itself ──
  try {
    const thumb: Uint8Array | undefined = await exifr.thumbnail(file);
    if (thumb && thumb.length > 500) {
      const bmp = await createImageBitmap(new Blob([thumb as BlobPart], { type: "image/jpeg" }));
      const tw = bmp.width, th = bmp.height;
      const W = canvas.width, H = canvas.height;
      const aspectMain = W / H, aspectThumb = tw / th;
      const tc = document.createElement("canvas");
      tc.width = tw;
      tc.height = th;
      const tctx = tc.getContext("2d", { willReadFrequently: true })!;
      tctx.drawImage(bmp, 0, 0);
      const tData = tctx.getImageData(0, 0, tw, th).data;
      // draw the main image at thumbnail size (fit inside, like cameras do)
      const mc = document.createElement("canvas");
      mc.width = tw;
      mc.height = th;
      const mctx = mc.getContext("2d", { willReadFrequently: true })!;
      mctx.fillStyle = "#000";
      mctx.fillRect(0, 0, tw, th);
      let dw = tw, dh = th, dx = 0, dy = 0;
      if (Math.abs(aspectMain - aspectThumb) > 0.02) {
        if (aspectMain > aspectThumb) { dh = tw / aspectMain; dy = (th - dh) / 2; }
        else { dw = th * aspectMain; dx = (tw - dw) / 2; }
      }
      mctx.drawImage(canvas, dx, dy, dw, dh);
      const mData = mctx.getImageData(0, 0, tw, th).data;

      let total = 0;
      const diffs = new Float32Array(tw * th);
      for (let i = 0, j = 0; i < tData.length; i += 4, j++) {
        const dd = (Math.abs(tData[i] - mData[i]) + Math.abs(tData[i + 1] - mData[i + 1]) + Math.abs(tData[i + 2] - mData[i + 2])) / 3;
        diffs[j] = dd;
        total += dd;
      }
      const meanDiff = total / (tw * th);
      if (meanDiff > 40) {
        ev({
          category: "metadata",
          severity: "warning",
          title: "Preview doesn't match the picture",
          detail: "The small preview stored inside the file shows a different picture (cropped, rotated or replaced).",
        });
        checks.push({ id: "thumb", label: "Embedded preview", status: "flag" });
      } else {
        // local differences = the area that was edited after the photo was taken
        const g = TamperGrid.like(grid);
        const sx = W / dw, sy = H / dh;
        const counts = new Float32Array(g.data.length);
        const cellPix = new Float32Array(g.data.length);
        for (let y = Math.ceil(dy); y < dy + dh - 1; y++) {
          for (let x = Math.ceil(dx); x < dx + dw - 1; x++) {
            const px = (x - dx) * sx, py = (y - dy) * sy;
            const k = Math.min(g.rows - 1, Math.floor(py / g.cellH)) * g.cols + Math.min(g.cols - 1, Math.floor(px / g.cellW));
            cellPix[k]++;
            if (diffs[y * tw + x] > Math.max(28, meanDiff * 4)) counts[k]++;
          }
        }
        for (let k = 0; k < counts.length; k++) if (cellPix[k] && counts[k] / cellPix[k] > 0.3) g.data[k] = 0.95;
        const regs = g.regions(0.5, 1);
        if (regs.length && regs.length < 12) {
          layers.push({
            id: "thumb",
            label: "Preview mismatch",
            color: "#FF00E5",
            description: "Areas that differ from the preview the camera stored when the photo was taken",
            grid: g.data,
            critical: true,
            strength: 0.95,
          });
          ev({
            category: "metadata",
            severity: "critical",
            title: "Changed after the photo was taken",
            detail: `The preview stored inside the file still shows the original. ${regs.length} area(s) of the picture no longer match it.`,
            regions: regs.map((r) => ({ ...r, label: "differs from preview" })),
            layerId: "thumb",
          });
          checks.push({ id: "thumb", label: "Embedded preview", status: "flag" });
        } else {
          checks.push({ id: "thumb", label: "Embedded preview", status: "pass" });
        }
      }
      bmp.close();
    } else {
      checks.push({ id: "thumb", label: "Embedded preview", status: "skip", note: "no preview stored" });
    }
  } catch {
    checks.push({ id: "thumb", label: "Embedded preview", status: "skip", note: "no preview stored" });
  }

  return { summary, evidence, layers, checks };
}
