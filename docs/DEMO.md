# VeriChain — Demo Script (≈5 minutes)

## Before you start

- `npm run dev` → open http://localhost:3000 (or the Vercel URL).
- Open the **Issuer Registry** panel once and click **Clear registry** so the demo starts clean.
- Optional: in the AI panel, download the LLM beforehand so the "On-device AI explanation" fills in.
- Everything below uses the **fictional sample files** on the home page — no real personal data.

## 1. The problem (30 s)

"Fake marksheets and edited Aadhaar cards are made in minutes with free online editors.
Verifiers usually don't have the original to compare with, and uploading IDs to cloud AI is a privacy risk.
VeriChain finds edits **without the original**, entirely **in the browser**."

## 2. The key idea (30 s)

"A heatmap needs something to compare against. With no original, we use four other references:"

1. **The document against itself:** grain, background, compression, and every number against its own row.
2. **Older versions hidden inside the file:** PDF re-saves, text under white boxes, the photo's stored preview.
3. **Signed data printed on it:** the Aadhaar Secure QR is signed by UIDAI.
4. **Its own rules:** the Aadhaar check digit; marks must add up to the total and percentage.

"Every check writes onto one shared grid: our spatial hash map. That grid becomes the Tamper Map."

## 3. Live demo

| Click | What to point at |
|---|---|
| **Genuine marksheet** | Also reads the printed **verification QR** and shows its link. "No signs of editing found": marks add up, a single save, consistent fonts. Note that we don't call it *genuine*; only the issuer's original proves that. |
| **Edited: white box + retyped mark** | **Edited**. *What was changed: 45 → 85.* The old "45" is still in the file under the new "85". The marks now add up to 476, but the total says 436. The file was saved by iLovePDF. The heatmap boxes the exact cell. |
| **Edited: marks, total & % changed** | The smart forger changed the mark, the total and the percentage, so **the arithmetic is consistent**. VeriChain recovered the **earlier version hidden inside the PDF**: 88→98, 436→446, 72.67→74.33. |
| **Signed marksheet (like DigiLocker)** | Signing adds a later save, and VeriChain knows that's normal: *signed, nothing added after signing*. No false alarm. |
| **Signed, then edited** | **Changed after it was signed**: 88→98, 436→446, 72.67→74.33. This is the DigiLocker / e-Aadhaar tamper case. |
| **Photo: mark whited-out & pasted** | Works on photos too. OCR runs on-device, and the marks don't add up (479 vs 436). The pasted digits have the wrong grain and darker ink. **Two independent checks agree** on the same cell. |
| **Screenshot: pasted digits** | Clean digital image: a slightly off-white background patch, and the pasted "88" sits 3 px below its row. |

### With the original: Issuer Registry (1 min)

1. Click **Start Over**, then **Genuine marksheet**. In **Issuer Registry**, click **Register this file as the original**.
2. Click **Start Over**, then **Edited: white box**. The registry now reports **Differs from the registered original**: 2 grid cells, "45" → "85".
3. Run **Genuine marksheet** again to get **Matches the registered original** (100).
4. Point at the **Spatial Merkle root**: "One leaf per grid row. This is what the issuer anchors on Polygon or prints as a QR, so any copy can be checked cell by cell, offline."

### Aadhaar (if you have your own card)

- Upload your **own** e-Aadhaar PDF. The password is the first 4 letters of the name in CAPITALS followed by the birth year, and it's used only in the browser.
- Show the **Signed QR vs Printed** table and **Check digit: valid**.
- What it catches: an edited date of birth, name, gender or number (when the QR doesn't match), or a single changed digit (the Verhoeff check fails).
- Only use your own card. Keep edited test copies private.

## 4. Privacy and honesty (30 s)

- Zero cloud calls: PDF parsing, OCR, QR, forensics and the AI all run in the browser, and the files never leave the device.
- The AI **explains** the verdict but doesn't make it. Verdicts come from deterministic, explainable checks.
- Limits, said openly:
  - A forgery rebuilt from scratch with clean files, or a photo of a printout, can pass the no-original checks. That's exactly why the issuer registry and self-verifying documents exist.
  - The UIDAI QR signature certificate check is next on the roadmap.

## Likely questions

- **"Can't the forger just fix the total?"** Yes. That's sample 3, and the hidden earlier version still exposes it.
- **"What if they retype the whole PDF?"** Metadata shows it wasn't produced by the issuer's system (Word, Chrome print). The QR or registry mismatch then proves it. Pixel checks alone can't.
- **"False positives?"** Pixel checks only become *warnings*. A region turns red only when a deterministic check fires or two independent checks agree. The genuine PDF and the genuine photo both come back clean.
- **"Why blockchain?"** To anchor the issuer's spatial Merkle root and revocation status, so verifiers don't have to trust our server.
