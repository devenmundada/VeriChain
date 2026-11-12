import { NextResponse } from "next/server";

/**
 * GET /api/verify/[id]
 *
 * For hackathon demo: returns a JSON proof record for the document ID.
 * In production this would query the blockchain / database.
 * Client-side, the proof is stored in memory (AppContext) so this route
 * serves as a lightweight SSR stub that returns a "not found" payload.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // In a real deployment, look up the id in a database / on-chain index
  // For the hackathon, we return a formatted response with the ID
  return NextResponse.json({
    documentId: id,
    status: "PENDING_CLIENT_VERIFICATION",
    message:
      "This proof must be verified client-side. Open the verification page in a browser that ran the pipeline.",
  });
}
