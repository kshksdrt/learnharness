/**
 * POST /api/client/claim {id} — this tab becomes the single active browser
 * client (browser-only mode); every other tab is displaced. Exempt from the
 * active-client check in Proxy (it is how a tab becomes active) but still
 * behind the Host and cross-site checks.
 *
 *   → 200 {enforced} — false in desktop mode, where nothing is recorded.
 *   → 400 on a missing/oversized id.
 */
import { claimActiveClient } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
	const id = body?.id;
	if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) {
		return Response.json({ error: "id must be 1-64 letters, digits or dashes." }, { status: 400 });
	}
	return Response.json({ enforced: claimActiveClient(id) });
}
