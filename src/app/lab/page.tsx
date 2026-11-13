import { notFound } from "next/navigation";
import LabClient from "./LabClient";

/**
 * Dev-only regression lab (`npm run dev` → /lab?base=<url of a folder of test files>&files=a.pdf,b.jpg).
 * Runs the real engine in this browser on each file and shows verdict + heatmap. 404 in production.
 */
export default function LabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <LabClient />;
}
