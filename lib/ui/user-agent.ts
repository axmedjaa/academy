/**
 * A short "device" and "browser" description of a stored User-Agent string
 * for the active-sessions list (design S01: "Windows laptop", "Chrome 129").
 * Display only; unknown strings fall back to "Unknown device".
 */
export function describeUserAgent(userAgent: string | null | undefined): { device: string; browser: string | null } {
  const ua = userAgent ?? "";
  if (!ua.trim()) return { device: "Unknown device", browser: null };

  const device = /iPad/.test(ua)
    ? "iPad"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /Android/.test(ua)
        ? /Mobile/.test(ua)
          ? "Android phone"
          : "Android tablet"
        : /Windows/.test(ua)
          ? "Windows computer"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux computer"
                : "Unknown device";

  const version = (pattern: RegExp) => ua.match(pattern)?.[1]?.split(".")[0];
  let browser: string | null = null;
  if (/Edg\//.test(ua)) browser = `Edge ${version(/Edg\/([\d.]+)/) ?? ""}`;
  else if (/OPR\//.test(ua)) browser = `Opera ${version(/OPR\/([\d.]+)/) ?? ""}`;
  else if (/Firefox\//.test(ua)) browser = `Firefox ${version(/Firefox\/([\d.]+)/) ?? ""}`;
  else if (/Chrome\//.test(ua)) browser = `Chrome${/Mobile/.test(ua) ? " Mobile" : ""} ${version(/Chrome\/([\d.]+)/) ?? ""}`;
  else if (/Safari\//.test(ua)) browser = `Safari ${version(/Version\/([\d.]+)/) ?? ""}`;
  else if (/HeadlessChrome|Playwright/.test(ua)) browser = "Automated browser";

  return { device, browser: browser?.trim() || null };
}
