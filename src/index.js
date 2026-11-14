// xy-hairclip Worker.
//
// Static files in ./public are served straight from Workers assets. Only /api/*
// runs this code: it proxies to the Apps Script web app bound to the hairclip
// Google Sheet (apps-script/Code.gs), which does the actual read and the locked
// check-and-write. The Apps Script URL and the shared token are Worker secrets,
// so neither ever reaches the browser.
//
// Writing a name needs the ADMIN_PASSCODE secret (sent by the claim form).
// Without that secret set, claims are refused; viewing the list stays public.
//
// Only the default export lives here: workerd treats any named export of the
// main module as an entrypoint, so pure helpers live in lib.js.

import { TOTAL, NAME_MAX, normaliseSlots, parseId, cleanName, sameOrigin, passcodeMatches } from "./lib.js";

const LIST_CACHE_SECONDS = 10;
const LIST_CACHE_KEY = "https://cache.xy-hairclip.internal/api/slots";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/slots" && request.method === "GET") return getSlots(env, ctx);
    if (pathname === "/api/claim" && request.method === "POST") return claim(request, env, ctx);
    if (pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);
    return env.ASSETS.fetch(request);
  },
};

async function getSlots(env, ctx) {
  if (!configured(env)) return notConfigured();

  const cache = sharedCache();
  if (cache) {
    const hit = await cache.match(LIST_CACHE_KEY);
    if (hit) return json(await hit.json());
  }

  const upstream = await callScript(env, { action: "list" });
  if (!upstream.ok) return json({ error: "Couldn't reach the list. Try again in a moment." }, 502);

  const body = { total: TOTAL, slots: normaliseSlots(upstream.data.slots) };
  if (cache) {
    const stored = new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${LIST_CACHE_SECONDS}` },
    });
    ctx.waitUntil(cache.put(LIST_CACHE_KEY, stored));
  }
  return json(body);
}

async function claim(request, env, ctx) {
  if (!sameOrigin(request)) return json({ error: "Bad origin." }, 403);
  if (!configured(env)) return notConfigured();
  if (!env.ADMIN_PASSCODE) {
    return json({ error: "Claims are closed right now.", code: "auth_not_configured" }, 503);
  }

  // Before the passcode check, so it also caps passcode guessing per IP.
  if (env.RL_CLAIM) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.RL_CLAIM.limit({ key: ip });
    if (!success) return json({ error: "Too many tries. Wait a minute, then try again." }, 429);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }
  if (!(await passcodeMatches(input?.passcode, env.ADMIN_PASSCODE))) {
    return json({ error: "Wrong passcode.", code: "unauthorised" }, 401);
  }
  const id = parseId(input?.id);
  const name = cleanName(input?.name);
  if (!id) return json({ error: `Pick a number from 1 to ${TOTAL}.` }, 400);
  if (!name) return json({ error: `Enter your name (up to ${NAME_MAX} characters).` }, 400);

  const upstream = await callScript(env, { action: "claim", id, name });
  if (!upstream.ok) return json({ error: "Couldn't save your pick. Try again." }, 502);

  // Whatever happened, the cached list may now be stale.
  const cache = sharedCache();
  if (cache) ctx.waitUntil(cache.delete(LIST_CACHE_KEY));

  const result = upstream.data;
  if (result.ok) return json({ ok: true, id, name: String(result.name || name) });
  if (result.error === "taken") {
    return json({ error: `#${pad(id)} was just taken. Pick another number.`, code: "taken" }, 409);
  }
  if (result.error === "busy") return json({ error: "Lots of people picking right now. Try again." }, 503);
  return json({ error: "Couldn't save your pick. Try again." }, 502);
}

// Apps Script web apps answer with a 302 to script.googleusercontent.com that
// carries the result; fetch follows it. Errors inside the script come back as an
// HTML page with status 200, so anything that isn't JSON counts as a failure.
async function callScript(env, payload) {
  try {
    const res = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: env.SHEET_TOKEN, ...payload }),
    });
    if (!res.ok) return { ok: false };
    const data = JSON.parse(await res.text());
    if (data.error === "unauthorised" || data.error === "bad_request") {
      console.error("apps script rejected request:", data.error);
      return { ok: false };
    }
    return { ok: true, data };
  } catch (err) {
    console.error("apps script call failed:", err);
    return { ok: false };
  }
}

function configured(env) {
  return Boolean(env.APPS_SCRIPT_URL && env.SHEET_TOKEN);
}

function notConfigured() {
  return json({ error: "Number picking opens soon.", code: "not_configured" }, 503);
}

// caches.default only exists on Workers (and only stores on custom domains).
function sharedCache() {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

function pad(id) {
  return String(id).padStart(2, "0");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
