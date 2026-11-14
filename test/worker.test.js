import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { cleanName, parseId, normaliseSlots, sameOrigin, passcodeMatches } from "../src/lib.js";

const HOST = "https://xy-hairclip.thebooleanjulian.dev";
const env = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/test/exec",
  SHEET_TOKEN: "secret-token",
  ADMIN_PASSCODE: "letmein",
  ASSETS: { fetch: async () => new Response("asset") },
};
const ctx = { waitUntil() {} };

let calls;
let scriptReply;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  scriptReply = () => new Response(JSON.stringify({ ok: true, slots: [] }));
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return scriptReply();
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Adds the correct passcode unless the test sets its own.
function claimRequest(body, origin = HOST) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  const payload = "passcode" in body ? body : { ...body, passcode: "letmein" };
  return new Request(`${HOST}/api/claim`, { method: "POST", headers, body: JSON.stringify(payload) });
}

test("passcodeMatches only accepts the exact passcode", async () => {
  assert.equal(await passcodeMatches("letmein", "letmein"), true);
  for (const bad of ["letmei", "letmein ", "LETMEIN", "", null, undefined, 123]) {
    assert.equal(await passcodeMatches(bad, "letmein"), false, String(bad));
  }
  assert.equal(await passcodeMatches("", ""), false);
  assert.equal(await passcodeMatches("x", undefined), false);
});

test("wrong or missing passcode is a 401 and never reaches the sheet", async () => {
  for (const passcode of ["nope", "", null]) {
    const res = await worker.fetch(claimRequest({ id: 11, name: "Sneaky", passcode }), env, ctx);
    assert.equal(res.status, 401, String(passcode));
    assert.equal((await res.json()).code, "unauthorised");
  }
  const omitted = new Request(`${HOST}/api/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: HOST },
    body: JSON.stringify({ id: 11, name: "Sneaky" }),
  });
  assert.equal((await worker.fetch(omitted, env, ctx)).status, 401);
  assert.equal(calls.length, 0);
});

test("claims are refused when ADMIN_PASSCODE is not set", async () => {
  const { ADMIN_PASSCODE, ...noPass } = env;
  const res = await worker.fetch(claimRequest({ id: 11, name: "a" }), noPass, ctx);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "auth_not_configured");
  assert.equal(calls.length, 0);
});

test("viewing the list needs no passcode", async () => {
  const { ADMIN_PASSCODE, ...noPass } = env;
  const res = await worker.fetch(new Request(`${HOST}/api/slots`), noPass, ctx);
  assert.equal(res.status, 200);
});

test("parseId accepts 1-39 as numbers or digit strings only", () => {
  assert.equal(parseId(1), 1);
  assert.equal(parseId("39"), 39);
  assert.equal(parseId(" 7 "), 7);
  for (const bad of [0, 40, -1, 1.5, "1.5", "abc", "", null, undefined, "1e1", true]) {
    assert.equal(parseId(bad), null, String(bad));
  }
});

test("cleanName trims, collapses whitespace, strips control chars, caps length", () => {
  assert.equal(cleanName("  Miku   Fan \n"), "Miku Fan");
  assert.equal(cleanName("a\u0000b\u200bc"), "abc");
  assert.equal(cleanName("x".repeat(40)), "x".repeat(40));
  assert.equal(cleanName("x".repeat(41)), null);
  assert.equal(cleanName("   "), null);
  assert.equal(cleanName(42), null);
  assert.equal(cleanName("初音ミク"), "初音ミク");
});

test("normaliseSlots always returns 39 slots and marks filled names as taken", () => {
  const slots = normaliseSlots([
    { id: 1, name: "xymiku.39" },
    { id: "39", name: 'Reserved for "Last piece"' },
    { id: 11, name: "" },
    { id: 99, name: "ignored" },
    null,
  ]);
  assert.equal(slots.length, 39);
  assert.deepEqual(slots[0], { id: 1, taken: true, name: "xymiku.39" });
  assert.deepEqual(slots[10], { id: 11, taken: false, name: "" });
  assert.equal(slots[38].taken, true);
  assert.equal(normaliseSlots(undefined).every((s) => !s.taken), true);
});

test("sameOrigin requires a matching Origin header", () => {
  assert.equal(sameOrigin(claimRequest({})), true);
  assert.equal(sameOrigin(claimRequest({}, "https://evil.example")), false);
  assert.equal(sameOrigin(claimRequest({}, null)), false);
});

test("GET /api/slots proxies the list with the token and never leaks it", async () => {
  scriptReply = () => new Response(JSON.stringify({ ok: true, slots: [{ id: 3, name: "Yewie" }] }));
  const res = await worker.fetch(new Request(`${HOST}/api/slots`), env, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0].body, { token: "secret-token", action: "list" });
  const text = await res.text();
  assert.ok(!text.includes("secret-token"));
  const body = JSON.parse(text);
  assert.equal(body.total, 39);
  assert.deepEqual(body.slots[2], { id: 3, taken: true, name: "Yewie" });
});

test("API answers 503 until secrets are set", async () => {
  const res = await worker.fetch(new Request(`${HOST}/api/slots`), { ASSETS: env.ASSETS }, ctx);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "not_configured");
  assert.equal(calls.length, 0);
});

test("upstream HTML error page becomes a 502", async () => {
  scriptReply = () => new Response("<html>Script error</html>", { status: 200 });
  const res = await worker.fetch(new Request(`${HOST}/api/slots`), env, ctx);
  assert.equal(res.status, 502);
});

test("POST /api/claim sends the cleaned name and returns ok", async () => {
  scriptReply = () => new Response(JSON.stringify({ ok: true, id: 11, name: "Miku Fan" }));
  const res = await worker.fetch(claimRequest({ id: 11, name: "  Miku   Fan " }), env, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: 11, name: "Miku Fan" });
  assert.deepEqual(calls[0].body, { token: "secret-token", action: "claim", id: 11, name: "Miku Fan" });
});

test("claiming a taken number is a 409 with code taken", async () => {
  scriptReply = () => new Response(JSON.stringify({ ok: false, error: "taken" }));
  const res = await worker.fetch(claimRequest({ id: 7, name: "Late" }), env, ctx);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "taken");
  assert.match(body.error, /#07/);
});

test("invalid claims are rejected before reaching the sheet", async () => {
  for (const body of [{ id: 0, name: "a" }, { id: 40, name: "a" }, { id: 5, name: "" }, { id: 5 }]) {
    const res = await worker.fetch(claimRequest(body), env, ctx);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const cross = await worker.fetch(claimRequest({ id: 5, name: "a" }, "https://evil.example"), env, ctx);
  assert.equal(cross.status, 403);
  assert.equal(calls.length, 0);
});

test("rate limit blocks claims with 429", async () => {
  const limited = { ...env, RL_CLAIM: { limit: async () => ({ success: false }) } };
  const res = await worker.fetch(claimRequest({ id: 5, name: "a" }), limited, ctx);
  assert.equal(res.status, 429);
  assert.equal(calls.length, 0);
});

test("token rejected by the script is reported as an upstream failure", async () => {
  scriptReply = () => new Response(JSON.stringify({ ok: false, error: "unauthorised" }));
  const res = await worker.fetch(claimRequest({ id: 5, name: "a" }), env, ctx);
  assert.equal(res.status, 502);
});

test("non-API paths go to static assets; unknown API paths 404", async () => {
  const page = await worker.fetch(new Request(`${HOST}/`), env, ctx);
  assert.equal(await page.text(), "asset");
  const missing = await worker.fetch(new Request(`${HOST}/api/nope`), env, ctx);
  assert.equal(missing.status, 404);
});
