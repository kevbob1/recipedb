import type { Config } from "@react-router/dev/config";

/**
 * Kevin's choice 2026-11-27: desktop API clients (Restfox on Electron,
 * `file://` UI) send the literal `Origin: null`, which the React Router
 * action guard treats as a foreign origin. `"*"` admits it — plus any
 * single-label host (plain-HTTP LAN / docker) — but the matcher keeps
 * rejecting multi-label hosts, so the app's own public hosts stay listed
 * explicitly (they also cover the HTTPS-vs-HTTP mismatch behind the
 * TLS-terminating ingress). `curl` sends no `Origin` header at all, so it
 * already bypasses this check.
 *
 * While `"*"` is listed the guard no longer blocks same-SITE sibling origins
 * under *.k.pd.o / *.p.drule.org; the SameSite=Lax session cookie is the
 * remaining defense. Do NOT weaken it below Lax while the wildcard is set.
 */
const allowedActionOrigins = ["*", "recipedb.k.pd.o", "recipedb.p.drule.org"];

export default {
  ssr: true,
  appDirectory: "app",
  allowedActionOrigins,
} satisfies Config;

export { allowedActionOrigins };
