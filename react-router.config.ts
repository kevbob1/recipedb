import type { Config } from "@react-router/dev/config";

/**
 * Hosts allowed to submit actions, on top of the default
 * "Origin must equal request.url's origin" rule.
 *
 * WHY THIS EXISTS: React Router refuses any mutation request whose `Origin`
 * header does not match the origin of `request.url` (its built-in CSRF
 * guard). Behind the nginx ingress TLS terminates at the edge, so the pod
 * only ever sees the plain-HTTP upstream URL (`http://recipedb.k.pd.o/...`)
 * while the browser correctly sends `Origin: https://recipedb.k.pd.o`. That
 * scheme-only mismatch made every real browser login POST fail with
 * `400 Bad Request` before the action ran, while `curl` (which sends no
 * `Origin` header at all) sailed through and looked healthy.
 *
 * Entries are HOSTS, not full origins: React Router compares each entry
 * against `new URL(origin).host` (micromatch globs like `**.k.pd.o` are
 * supported). Keep this list to the hosts we actually serve over TLS — a
 * wider entry would re-open the CSRF hole the guard exists to close.
 * Plain-HTTP LAN/docker access needs no entry: there `Origin` and
 * `request.url` already agree.
 */
const allowedActionOrigins = ["recipedb.k.pd.o", "recipedb.p.drule.org"];

export default {
  ssr: true,
  appDirectory: "app",
  allowedActionOrigins,
} satisfies Config;

export { allowedActionOrigins };
