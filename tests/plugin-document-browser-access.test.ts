import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { NextRequest } from "next/server";

// The active-client file lives under LH_DATA_DIR: isolate it BEFORE the
// config-loading imports (hence dynamic).
process.env.LH_DATA_DIR = mkdtempSync(path.join(tmpdir(), "lh-document-access-"));
const { proxy } = await import("../proxy.ts");
const { createPluginDocumentRoute } = await import("../src/server/plugin-transport.ts");
const { claimActiveClient } = await import("../src/server/active-client.ts");

it("streamed document route shares browser policy before params, plugin work or multipart body access", async t => {
	const keys = ["LH_DESKTOP_SERVER", "LH_DESKTOP_API_SECRET", "LH_ALLOWED_HOSTS"] as const;
	const saved = keys.map(key => process.env[key]);
	for (const key of keys) delete process.env[key];
	try {
		const convert = t.mock.fn(async () => Response.json({ markdown: "owned fixture" }));
		const route = createPluginDocumentRoute({ convertDocument: convert });
		const methods = ["POST", "GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"] as const;
		for (const method of methods) {
			const cases: { host: string; origin: string | undefined; site: string | undefined }[] = [{ host: "rebind.invalid", origin: undefined, site: undefined }];
			if (!["GET", "HEAD", "OPTIONS"].includes(method)) cases.push(
				{ host: "localhost", origin: "https://other.invalid", site: "cross-site" },
				{ host: "localhost", origin: "null", site: "cross-site" },
			);
			for (const { host, origin, site } of cases) {
				const headers: Record<string, string> = { host, "content-type": "multipart/form-data; boundary=owned" };
				if (origin) headers.origin = origin;
				if (site) headers["sec-fetch-site"] = site;
				const url = `http://${host}/api/plugins/document-one/documents/markdown`;
				const request = new Request(url, { method, headers });
				let bodyAccesses = 0, paramsAccesses = 0;
				Object.defineProperty(request, "body", { get() { bodyAccesses++; throw new Error("body accessed before policy"); } });
				const context = { get params(): Promise<{ id: string }> { paramsAccesses++; throw new Error("params accessed before policy"); } };
				const response = method === "POST" ? await route.POST(request, context) : await route[method](request);
				const control = proxy(new NextRequest(url, { method, headers }));
				assert.equal(response.status, 403, `${method}: ${host} ${origin}`);
				assert.equal(response.headers.get("cache-control"), "no-store");
				assert.deepEqual(await response.json(), await control.json());
				assert.equal(bodyAccesses, 0);
				assert.equal(paramsAccesses, 0);
				assert.equal(request.bodyUsed, false);
			}
		}
		assert.equal(convert.mock.callCount(), 0);
		const form = new FormData(); form.append("file", new File(["owned fixture"], "small.txt"));
		const documentUrl = "http://localhost/api/plugins/document-one/documents/markdown";
		const sameOrigin = { origin: "http://localhost", "sec-fetch-site": "same-origin" };
		claimActiveClient("tab-a", {});
		const displaced = await route.POST(new Request(documentUrl, { method: "POST", headers: { ...sameOrigin, "x-learnharness-client": "tab-old" }, body: form }), { params: Promise.resolve({ id: "document-one" }) });
		assert.equal(displaced.status, 409, "a displaced tab is refused like Proxy refuses it");
		assert.deepEqual(await displaced.json(), { error: "displaced" });
		assert.equal(convert.mock.callCount(), 0);
		const post = new Request(documentUrl, {
			method: "POST", headers: { ...sameOrigin, "x-learnharness-client": "tab-a" }, body: form,
		});
		assert.equal((await route.POST(post, { params: Promise.resolve({ id: "document-one" }) })).status, 200);
		assert.equal(convert.mock.callCount(), 1);
		assert.equal(post.bodyUsed, false, "authorized route forwards the original stream");
	} finally {
		keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
	}
});
