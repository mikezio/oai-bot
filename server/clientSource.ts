export type MessageSource = "desktop" | "mobile";

/**
 * The durable envelope records a device class, not the renderer technology.
 * Older browser builds sent `web`; keep those queued sends replayable.
 */
export function normalizeMessageSource(value: unknown): MessageSource {
  const source = String(value || "desktop").trim().toLowerCase();
  if (source === "mobile") return "mobile";
  if (source === "desktop" || source === "web") return "desktop";
  throw Object.assign(new Error("source must be desktop or mobile"), { statusCode: 400 });
}
