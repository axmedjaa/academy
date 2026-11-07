/**
 * The application Redis client must (a) never make a caller wait more than
 * its command timeout and (b) reconnect on its own after an outage — it used
 * to give up after 3 attempts and stay closed until the process restarted.
 *
 * Uses a minimal in-process RESP server on 127.0.0.1 that the test can stop
 * and start, and a client built with the real application options. No real
 * Redis is involved.
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { appRedisOptions, appRedisRetryDelay, createAppRedisClient, REDIS_MAX_RECONNECT_DELAY_MS } from "./redis";
import type Redis from "ioredis";

/** Just enough RESP for ioredis: INFO (ready check), INCR, PING; +OK otherwise. */
class FakeRedis {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private counters = new Map<string, number>();
  constructor(public port = 0) {}

  async start(): Promise<void> {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const parsed = parseCommand(buffer);
          if (!parsed) break;
          buffer = buffer.slice(parsed.consumed);
          socket.write(this.reply(parsed.args));
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, "127.0.0.1", resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private reply(args: string[]): string {
    const name = (args[0] ?? "").toUpperCase();
    if (name === "INFO") {
      const body = "# Server\r\nredis_version:7.0.0\r\nloading:0\r\n";
      return `$${Buffer.byteLength(body)}\r\n${body}\r\n`;
    }
    if (name === "PING") return "+PONG\r\n";
    if (name === "INCR") {
      const next = (this.counters.get(args[1]) ?? 0) + 1;
      this.counters.set(args[1], next);
      return `:${next}\r\n`;
    }
    return "+OK\r\n";
  }
}

function parseCommand(input: string): { args: string[]; consumed: number } | null {
  if (!input.startsWith("*")) return null;
  let pos = input.indexOf("\r\n");
  if (pos < 0) return null;
  const count = Number(input.slice(1, pos));
  pos += 2;
  const args: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const end = input.indexOf("\r\n", pos);
    if (end < 0) return null;
    const length = Number(input.slice(pos + 1, end));
    const start = end + 2;
    if (input.length < start + length + 2) return null;
    args.push(input.slice(start, start + length));
    pos = start + length + 2;
  }
  return { args, consumed: pos };
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const clients: Redis[] = [];
const servers: FakeRedis[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const server of servers.splice(0)) await server.stop();
});

describe("application Redis client options", () => {
  it("never stops reconnecting, and backs off to at most 5 s", () => {
    for (const attempt of [1, 2, 3, 4, 10, 100, 10_000]) {
      const delay = appRedisRetryDelay(attempt);
      expect(typeof delay).toBe("number");
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(REDIS_MAX_RECONNECT_DELAY_MS);
    }
    expect(appRedisRetryDelay(1)).toBe(200);
    expect(appRedisRetryDelay(10_000)).toBe(REDIS_MAX_RECONNECT_DELAY_MS);
  });

  it("bounds every command and keeps the first command after start-up working", () => {
    const options = appRedisOptions();
    expect(options.commandTimeout).toBe(3_000);
    expect(options.lazyConnect).toBe(true);
    // Disabling the offline queue would reject the first command issued while
    // the lazy connection is still opening.
    expect(options.enableOfflineQueue).toBe(true);
    expect(options.maxRetriesPerRequest).toBe(1);
  });
});

describe("outage and recovery", { timeout: 60_000 }, () => {
  it("the first command after start-up succeeds (lazy connect + queue)", async () => {
    const server = new FakeRedis();
    servers.push(server);
    await server.start();
    const client = createAppRedisClient(`redis://127.0.0.1:${server.port}`);
    clients.push(client);
    await expect(client.incr("first")).resolves.toBe(1);
  });

  it("fails fast while Redis is down, then recovers by itself when Redis comes back", async () => {
    const port = await freePort();
    const client = createAppRedisClient(`redis://127.0.0.1:${port}`);
    clients.push(client);

    // Down: the command is refused within the command timeout, never hangs.
    const started = Date.now();
    await expect(client.incr("k")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_500);

    // Keep it down past the old 3-attempt limit (≈ 200+400+600 ms of backoff).
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(client.status).not.toBe("end");

    // Up again on the same port: the client reconnects without a restart.
    const server = new FakeRedis(port);
    servers.push(server);
    await server.start();
    await expect.poll(async () => client.incr("k").catch(() => null), { timeout: 15_000, interval: 250 }).not.toBeNull();
    expect(client.status).toBe("ready");
  });

  it("recovers after the connection drops mid-life", async () => {
    const server = new FakeRedis();
    servers.push(server);
    await server.start();
    const client = createAppRedisClient(`redis://127.0.0.1:${server.port}`);
    clients.push(client);
    await expect(client.incr("x")).resolves.toBe(1);

    const port = server.port;
    await server.stop();
    await expect(client.incr("x")).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const again = new FakeRedis(port);
    servers.push(again);
    await again.start();
    await expect.poll(async () => client.incr("y").catch(() => null), { timeout: 15_000, interval: 250 }).toBe(1);
  });
});
