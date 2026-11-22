/**
 * ONE ACTIVE BROWSER CLIENT (browser-only mode): the newest claim wins,
 * Proxy refuses a displaced tab's browser requests with 409, non-browser
 * callers without an id pass, desktop mode is untouched, and the events
 * channel answers a stale id with a client-displaced frame.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";

process.env.LH_DATA_DIR = mkdtempSync(path.join(tmpdir(), "lh-active-client-"));
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
delete process.env.LH_ALLOWED_HOSTS;

const { activeClientRefusal, claimActiveClient, clientDisplaced, readActiveClient } = await import("../src/server/active-client.ts");
const { subscribe } = await import("../src/core/events.ts");
const { eventsResponse } = await import("../src/server/events-stream.ts");
const { proxy } = await import("../proxy.ts");
const { wrapFetch, isOwnApiUrl } = await import("../components/client-lock.tsx");

const browser = { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" };
const file = () => path.join(mkdtempSync(path.join(tmpdir(), "lh-ac-")), "nested", "active-client");

describe("claimActiveClient", () => {
	it("records the newest claim and notifies every window", () => {
		const f = file();
		const got: unknown[] = [];
		const off = subscribe((e) => { if (e.type === "client-displaced") got.push(e); });
		assert.equal(claimActiveClient("tab-a", {}, f), true);
		assert.equal(claimActiveClient("tab-b", {}, f), true);
		off();
		assert.equal(readActiveClient(f), "tab-b");
		assert.deepEqual(got, [{ type: "client-displaced", active: "tab-a" }, { type: "client-displaced", active: "tab-b" }]);
	});

	it("is a no-op in desktop mode", () => {
		const f = file();
		assert.equal(claimActiveClient("tab-a", { LH_DESKTOP_SERVER: "1" }, f), false);
		assert.equal(existsSync(f), false);
	});
});

describe("activeClientRefusal", () => {
	const f = file();
	claimActiveClient("tab-a", {}, f);
	const req = (url: string, headers: Record<string, string>) => new Request(`http://localhost:3000${url}`, { method: "POST", headers });

	it("passes the active tab and refuses a displaced or id-less browser request", () => {
		assert.equal(activeClientRefusal(req("/api/chats", { ...browser, "x-learnharness-client": "tab-a" }), {}, f), undefined);
		assert.equal(activeClientRefusal(req("/api/chats", { ...browser, "x-learnharness-client": "tab-old" }), {}, f), "displaced");
		assert.equal(activeClientRefusal(req("/api/chats", browser), {}, f), "displaced");
	});

	it("passes non-browser callers without an id, but not with a stale one", () => {
		assert.equal(activeClientRefusal(req("/api/chats", {}), {}, f), undefined);
		assert.equal(activeClientRefusal(req("/api/chats", { "x-learnharness-client": "tab-old" }), {}, f), "displaced");
	});

	it("exempts the claim route and the events channel", () => {
		assert.equal(activeClientRefusal(req("/api/client/claim", browser), {}, f), undefined);
		assert.equal(activeClientRefusal(req("/api/events", browser), {}, f), undefined);
	});

	it("never applies in desktop mode", () => {
		assert.equal(activeClientRefusal(req("/api/chats", browser), { LH_DESKTOP_SERVER: "1" }, f), undefined);
		assert.equal(clientDisplaced("tab-old", { LH_DESKTOP_SERVER: "1" }, f), false);
	});

	it("clientDisplaced: only a present, non-active id is stale", () => {
		assert.equal(clientDisplaced("tab-a", {}, f), false);
		assert.equal(clientDisplaced("tab-old", {}, f), true);
		assert.equal(clientDisplaced(null, {}, f), false);
	});
});

describe("proxy", () => {
	it("answers a displaced tab with 409 {error: displaced}", async () => {
		claimActiveClient("tab-new", {});
		const res = proxy(new NextRequest("http://localhost:3000/api/chats", { headers: { ...browser, "x-learnharness-client": "tab-old" } }));
		assert.equal(res.status, 409);
		assert.deepEqual(await res.json(), { error: "displaced" });
		const ok = proxy(new NextRequest("http://localhost:3000/api/chats", { headers: { ...browser, "x-learnharness-client": "tab-new" } }));
		assert.equal(ok.headers.get("x-middleware-next"), "1");
	});
});

describe("eventsResponse displacedBy", () => {
	it("opens with a client-displaced frame naming the active client", async () => {
		const reader = eventsResponse({ displacedBy: "tab-new" }).body!.getReader();
		const { value } = await reader.read();
		assert.equal(new TextDecoder().decode(value!), 'event: client-displaced\ndata: {"active":"tab-new"}\n\n');
		await reader.cancel();
	});
});

describe("wrapFetch", () => {
	const origin = "http://localhost:3000";
	function fake(status = 200, body: unknown = {}) {
		const calls: Array<{ input: RequestInfo | URL; headers: Headers }> = [];
		const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ input, headers: new Headers(init?.headers) });
			return Response.json(body, { status });
		}) as typeof fetch;
		return { f, calls };
	}

	it("adds the id only on same-origin /api requests, keeping existing headers", async () => {
		const { f, calls } = fake();
		const wrapped = wrapFetch(f, "tab-a", origin, () => {});
		await wrapped("/api/chats", { headers: { "content-type": "application/json" } });
		await wrapped(new Request(`${origin}/api/jobs`, { headers: { accept: "x/y" } }));
		await wrapped("https://example.com/api/chats");
		await wrapped("/apis/other");
		assert.equal(calls[0]!.headers.get("x-learnharness-client"), "tab-a");
		assert.equal(calls[0]!.headers.get("content-type"), "application/json");
		assert.equal(calls[1]!.headers.get("x-learnharness-client"), "tab-a");
		assert.equal(calls[1]!.headers.get("accept"), "x/y");
		assert.equal(calls[2]!.headers.get("x-learnharness-client"), null);
		assert.equal(calls[3]!.headers.get("x-learnharness-client"), null);
	});

	it("locks on a displaced 409, not on other 409s", async () => {
		let displaced = 0;
		await wrapFetch(fake(409, { error: "displaced" }).f, "t", origin, () => displaced++)("/api/chats");
		await wrapFetch(fake(409, { error: "conflict" }).f, "t", origin, () => displaced++)("/api/chats");
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(displaced, 1);
	});

	it("isOwnApiUrl matches /api and /api/… on this origin only", () => {
		assert.equal(isOwnApiUrl(new URL(`${origin}/api`), origin), true);
		assert.equal(isOwnApiUrl(new URL(`${origin}/api/x`), origin), true);
		assert.equal(isOwnApiUrl(new URL(`${origin}/chat`), origin), false);
		assert.equal(isOwnApiUrl(new URL("http://localhost:4000/api/x"), origin), false);
	});
});
