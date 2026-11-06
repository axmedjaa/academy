import { readinessReport, readinessResponse } from "@/lib/monitoring/readiness";

/**
 * GET /api/health/ready — readiness probe for the reverse proxy and
 * orchestration: 200 when this instance can serve requests (database
 * reachable), 503 otherwise. Redis is reported but not required; see
 * lib/monitoring/readiness.ts. The response carries only "ok"/"error".
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return readinessResponse(await readinessReport());
}
