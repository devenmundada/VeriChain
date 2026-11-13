// pdf.js ships its standalone image decoders (JPEG 2000 via OpenJPEG) without type declarations.
declare module "pdfjs-dist/image_decoders/pdf.image_decoders.mjs" {
  export const JpxImage: {
    decode(data: Uint8Array, options?: object): Uint8ClampedArray;
  };
}
