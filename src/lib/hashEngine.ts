/**
 * Cryptographic Hashing Engine
 * - SHA-256 via Web Crypto API (real cryptographic hash)
 * - Perceptual Hash (pHash) via DCT on grayscale thumbnail
 */

export interface HashResult {
  sha256: string;
  pHash: string;
  fileSize: number;
  timestamp: string;
}

/**
 * Compute SHA-256 hash of a file using Web Crypto API
 */
export async function computeSHA256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute Perceptual Hash (pHash)
 * 1. Resize to 32x32
 * 2. Convert to grayscale
 * 3. Apply DCT
 * 4. Take top-left 8x8 of DCT
 * 5. Compute median
 * 6. Generate binary hash based on median comparison
 */
export async function computePerceptualHash(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      // For non-images, hash the first 1024 bytes as a fingerprint
      const reader = new FileReader();
      reader.onload = async (e) => {
        const buffer = e.target?.result as ArrayBuffer;
        const slice = buffer.slice(0, Math.min(1024, buffer.byteLength));
        const hashBuffer = await crypto.subtle.digest("SHA-256", slice);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        resolve(hashArray.slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join(""));
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsArrayBuffer(file);
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = (e) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const size = 32;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0, size, size);
          const imageData = ctx.getImageData(0, 0, size, size);

          // Convert to grayscale
          const gray: number[] = [];
          for (let i = 0; i < imageData.data.length; i += 4) {
            gray.push(
              0.299 * imageData.data[i] +
              0.587 * imageData.data[i + 1] +
              0.114 * imageData.data[i + 2]
            );
          }

          // Simplified DCT (Type-II) on 32x32
          const dctSize = 32;
          const dct: number[] = new Array(dctSize * dctSize).fill(0);

          for (let u = 0; u < dctSize; u++) {
            for (let v = 0; v < dctSize; v++) {
              let sum = 0;
              for (let x = 0; x < dctSize; x++) {
                for (let y = 0; y < dctSize; y++) {
                  sum +=
                    gray[x * dctSize + y] *
                    Math.cos(((2 * x + 1) * u * Math.PI) / (2 * dctSize)) *
                    Math.cos(((2 * y + 1) * v * Math.PI) / (2 * dctSize));
                }
              }
              const cu = u === 0 ? 1 / Math.sqrt(2) : 1;
              const cv = v === 0 ? 1 / Math.sqrt(2) : 1;
              dct[u * dctSize + v] =
                (2 / dctSize) * cu * cv * sum;
            }
          }

          // Extract top-left 8x8 (excluding DC component at [0,0])
          const lowFreq: number[] = [];
          for (let u = 0; u < 8; u++) {
            for (let v = 0; v < 8; v++) {
              if (u === 0 && v === 0) continue;
              lowFreq.push(dct[u * dctSize + v]);
            }
          }

          // Median
          const sorted = [...lowFreq].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];

          // Binary hash
          let hash = "";
          for (const val of lowFreq) {
            hash += val > median ? "1" : "0";
          }

          // Convert binary to hex
          let hexHash = "";
          for (let i = 0; i < hash.length; i += 4) {
            const nibble = hash.slice(i, i + 4).padEnd(4, "0");
            hexHash += parseInt(nibble, 2).toString(16);
          }

          resolve(hexHash);
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Run both hashes and return combined result
 */
export async function generateHashes(file: File): Promise<HashResult> {
  const [sha256, pHash] = await Promise.all([
    computeSHA256(file),
    computePerceptualHash(file),
  ]);

  return {
    sha256,
    pHash,
    fileSize: file.size,
    timestamp: new Date().toISOString(),
  };
}
