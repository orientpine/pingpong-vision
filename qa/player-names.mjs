// The tournament server now wants "name,1234" player entries. Older servers (GET /api/players -> 404) take plain names.
// withCodes() appends a stable four-digit code (1001, 1002, ...) when the route exists (200, 403, anything but 404).
export async function withCodes(baseUrl, names, fetchImpl = fetch) {
  const res = await fetchImpl(new URL("/api/players", baseUrl).href);
  if (res.status === 404) return [...names];
  return names.map((n, i) => `${n},${1001 + i}`);
}
