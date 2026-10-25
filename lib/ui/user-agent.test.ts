import { describe, expect, it } from "vitest";
import { describeUserAgent } from "./user-agent";

describe("describeUserAgent", () => {
  it("describes a Windows Chrome session", () => {
    expect(
      describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"),
    ).toEqual({ device: "Windows computer", browser: "Chrome 129" });
  });

  it("describes an Android phone on Chrome Mobile", () => {
    expect(
      describeUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"),
    ).toEqual({ device: "Android phone", browser: "Chrome Mobile 129" });
  });

  it("describes Safari on a Mac and Edge on Windows", () => {
    expect(
      describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"),
    ).toEqual({ device: "Mac", browser: "Safari 17" });
    expect(
      describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0.1"),
    ).toEqual({ device: "Windows computer", browser: "Edge 129" });
  });

  it("falls back for a missing or unknown agent", () => {
    expect(describeUserAgent(null)).toEqual({ device: "Unknown device", browser: null });
    expect(describeUserAgent("curl/8.0")).toEqual({ device: "Unknown device", browser: null });
  });
});
