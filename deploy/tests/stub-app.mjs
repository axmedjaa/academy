// Stands in for `next start`: serves /api/health in the shape of
// app/api/health/route.ts, or a deliberately broken variant.
import http from "node:http";
const mode = process.argv[2] || "ok";
const port = Number(process.argv[3] || 3999);
let requests = 0;
const ok = { status: "ok", checks: { database: "ok", redis: "ok", queue: "ok" } };
const degraded = (c) => ({ status: "degraded", checks: { database: "ok", redis: "ok", queue: "ok", ...c } });
const responses = {
  ok: () => [200, ok],
  queue: () => [503, degraded({ queue: "error" })],
  db: () => [503, degraded({ database: "error" })],
  redis: () => [503, degraded({ redis: "error", queue: "error" })],
  dbthenok: () => (requests <= 2 ? [503, degraded({ database: "error" })] : [200, ok]),
  badjson: () => [503, "{not json"],
  missing: () => [503, { status: "degraded", checks: { database: "ok", redis: "ok" } }],
  extra: () => [503, { ...degraded({ queue: "error" }), note: "x" }],
  contradict: () => [200, { status: "ok", checks: { database: "ok", redis: "ok", queue: "error" } }],
  badvalue: () => [503, degraded({ queue: "error", redis: "maybe" })],
  degradedok: () => [503, { status: "degraded", checks: { database: "ok", redis: "ok", queue: "ok" } }],
  array: () => [200, [ok]],
  s500: () => [500, { status: "degraded", checks: { database: "ok", redis: "ok", queue: "error" } }],
  slow: () => [200, ok],
};
if (mode === "never") process.exit(0); // crashes before listening
const server = http.createServer((req, res) => {
  requests++;
  const [code, body] = responses[mode]();
  res.writeHead(code, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
});
setTimeout(() => server.listen(port, "127.0.0.1"), mode === "slow" ? 3000 : 0);
