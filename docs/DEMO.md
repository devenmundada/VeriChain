# VeriChain — Demo Script (≈5 minutes)

## Before you start

- `npm run dev` → open http://localhost:3000 (or the Vercel URL).
- Open the **Issuer Registry** panel once and click **Clear registry** so the demo starts clean.
- In the AI panel, click **Download all models** before you start: about 60 s the first time, about 3 s after that because the models are cached. The verdict card then gets an on-device AI explanation, and "Read aloud" works.
- Leave **TOOLS** (tool-calling) **off**. It runs long generations that can freeze the page; the normal chat answers in 3–5 s.
- Everything below uses the **fictional sample files** on the home page — no real personal data.

## 1. The problem (30 s)

"Fake marksheets and edited Aadhaar cards are made in minutes with free online editors.
Verifiers usually don't have the original to compare with, and uploading IDs to cloud AI is a privacy risk.
VeriChain finds edits **without the original**, entirely **in the browser**."

## 2. The key idea (30 s)

"A heatmap needs something to compare against. With no original, we use four other references:"

1. **The document against itself:** grain, background, compression, and every number against its own row.
2. **Older versions hidden inside the file:** PDF re-saves, text under white boxes, the photo's stored preview.
3. **Signed data printed on it:** the Aadhaar Secure QR is signed by UIDAI and carries the name, date of birth, gender,
   address and even the holder's **photo**.
4. **Its own rules:** the Aadhaar check digit and required fields; marks must add up to the total and percentage;
   on grade cards SGPA = credit points ÷ credits and CGPA = cumulative points ÷ cumulative credits.

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
- Show the **Signed QR vs Printed** table: name, DOB, gender, last 4 digits, PIN code and **Photo: same photo (9x %)**.
  "We decode the photo UIDAI signed inside the QR and compare it with the printed photo, so a swapped photo is caught."
- What it catches (tested on real e-Aadhaar files):
  - DOB changed in **Canva** (whole file re-made), or in **iLovePDF** (a "6" typed over the "5"): *01-01-1990 (QR) → 01-01-1991 (printed)*.
  - Name, gender, number or PIN changed; the DOB erased; the photo replaced or pasted over.
  - A photo of the card with the DOB and gender removed: "Date of birth and gender missing from the card", boxed exactly where they belong.
- An unlocked copy (password removed with iLovePDF) still comes back "No signs of editing" when every detail **and the photo** match the signed QR.
- Only use your own card. Keep edited test copies private — never upload them anywhere.

### Grade card (SGPA / CGPA)

- A real grade card with its CGPA raised by one point in Canva: *CGPA must equal cumulative credit points ÷ cumulative credits*, so the raised value doesn't add up. A single raised grade
  (BC → AA) is caught too, because credits × grade points no longer add up to the credit points.

## 4. Privacy and honesty (30 s)

- Zero cloud calls: PDF parsing, OCR, QR, forensics and the AI all run in the browser, and the files never leave the device.
- The AI **explains** the verdict but doesn't make it. Verdicts come from deterministic, explainable checks.
- Limits, said openly:
  - A forgery rebuilt from scratch with clean files, or a photo of a printout, can pass the no-original checks. That's exactly why the issuer registry and self-verifying documents exist.
  - The UIDAI QR signature certificate check is next on the roadmap.

## Likely questions

- **"Can't the forger just fix the total?"** Yes. That's sample 3, and the hidden earlier version still exposes it.
- **"What if they retype the whole PDF?"** Metadata shows it wasn't produced by the issuer's system (Word, Chrome print). The QR or registry mismatch then proves it. Pixel checks alone can't.
- **"False positives?"** Pixel checks only become *warnings* (on ID cards, one pixel check alone is only information). A region turns red only when a deterministic check fires or two independent checks agree. Genuine PDFs, screenshots, WhatsApp-compressed photos and high-resolution scans of the same documents all come back clean.
- **"What if the QR can't be read (WhatsApp photo)?"** Then VeriChain still checks what every Aadhaar must print (DOB, gender), that all printed copies of the number agree, and the check digit. A changed name on such a photo can't be proven — ask for the e-Aadhaar PDF.
- **"Why blockchain?"** To anchor the issuer's spatial Merkle root and revocation status, so verifiers don't have to trust our server.
