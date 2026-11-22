/**
 * THE NOTIFICATION CHANNEL ROUTE (push-architecture slice 1, 2026-10-02):
 * one SSE connection per open window over the core event bus — the
 * endpoint every future consumer (chat view, sidebar, activity dock)
 * subscribes to as the polls retire. The response plumbing lives in the
 * server seam (events-stream.ts); the framework route stays a thin
 * wrapper (the import law; tests drive the seam directly).
 *
 * ?client=<id>: EventSource cannot send headers, so the per-tab id rides
 * the query. A stale id gets a client-displaced frame first.
 */
import { CLIENT_QUERY } from "@/src/core";
import { clientDisplaced, eventsResponse, readActiveClient } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
	const id = new URL(request.url).searchParams.get(CLIENT_QUERY);
	return eventsResponse(clientDisplaced(id) ? { displacedBy: readActiveClient() ?? "" } : {});
}
