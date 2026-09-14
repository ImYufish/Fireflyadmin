import type { APIRoute } from "astro";
import { clearSessionCookie, isSameOrigin } from "../lib/auth";
import { errorResponse, okResponse } from "../lib/http";

export const POST: APIRoute = async (Astro) => {
	if (!isSameOrigin(Astro)) {
		return errorResponse("跨站请求被拒绝", 403);
	}
	clearSessionCookie(Astro);
	return okResponse();
};
