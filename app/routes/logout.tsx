/**
 * /logout — drop the session cookie and send the user back to /login.
 *
 * Logout is a POST-only action so a stray link prefetcher or an
 * embedded image can't log you out. The loader returns 405 for the
 * GET case so a typo'd GET still does the right thing.
 */
import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { buildClearSessionCookie } from "../lib/session.server";

export async function action(_args: Route.ActionArgs) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Set-Cookie": buildClearSessionCookie(),
    },
  });
}

export async function loader(_args: Route.LoaderArgs) {
  return new Response("Use POST to sign out.", {
    status: 405,
    headers: { Allow: "POST", "content-type": "text/plain" },
  });
}

export default function LogoutRoute() {
  // Should never render: the action redirects before a body is needed.
  return null;
}
