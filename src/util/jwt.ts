export function jwtExpiryMs(token: unknown): number | undefined {
  if (typeof token !== "string" || token.split(".").length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload?.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0
      ? payload.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}
