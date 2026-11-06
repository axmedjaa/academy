/**
 * GET /api/health/live — liveness probe. Answers 200 whenever the Node
 * process can serve a request at all. Deliberately touches no database,
 * Redis or queue: a dependency outage must never get a healthy process
 * restarted. Use /api/health/ready for dependency checks.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
