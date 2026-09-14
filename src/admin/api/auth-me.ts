import type { APIRoute } from "astro";
import { getSession, unauthorizedResponse } from "../lib/auth";
import { okResponse } from "../lib/http";

export const GET: APIRoute = async (Astro) => {
	const session = getSession(Astro);
	if (!session) return unauthorizedResponse();
	return okResponse({
		user: {
			login: session.login,
			name: session.name,
			avatar: session.avatar,
		},
		exp: session.exp,
	});
};
