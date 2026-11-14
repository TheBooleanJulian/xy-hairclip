// Pure helpers for the Worker (kept out of index.js; see the note there).

export const TOTAL = 39;
export const NAME_MAX = 40;

export function normaliseSlots(rows) {
  const names = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = parseId(row?.id);
    if (id) names.set(id, String(row.name ?? "").trim());
  }
  const slots = [];
  for (let id = 1; id <= TOTAL; id++) {
    const name = names.get(id) || "";
    slots.push({ id, taken: name !== "", name });
  }
  return slots;
}

export function parseId(value) {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= TOTAL ? n : null;
}

export function cleanName(value) {
  if (typeof value !== "string") return null;
  const name = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return name && [...name].length <= NAME_MAX ? name : null;
}

export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

// Constant-time comparison: hashing both sides first gives equal-length inputs,
// so neither the length nor the content of the passcode leaks through timing.
export async function passcodeMatches(given, expected) {
  if (typeof given !== "string" || given === "" || typeof expected !== "string" || expected === "") return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, expected].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))),
  );
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
