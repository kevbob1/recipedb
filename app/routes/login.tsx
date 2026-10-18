/**
 * /login — the family-password gate.
 *
 * Public route: anyone (in the house) can reach it. The form POSTs to
 * its own action; on success we set the session cookie and redirect to
 * the page the user was trying to reach (the `next` param, validated
 * to a same-origin path so an attacker can't make us redirect off-site).
 *
 * A valid session that hits /login is bounced to / so the login page
 * never traps a logged-in user.
 */
import { Form, Link, redirect, useActionData, useSearchParams } from "react-router";
import type { Route } from "./+types/login";
import { readSessionFromRequest } from "../lib/session.server";
import {
  assertHashIsArgon2id,
  buildSessionCookie,
  verifyPassword,
} from "../lib/auth.server";

type LoginError = {
  ok: false;
  error: "auth-not-configured" | "bad-password";
  message: string;
};

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Sign in — recipedb" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  // If you already have a valid session, /login has nothing to offer.
  if (readSessionFromRequest(request)) {
    return redirect("/");
  }
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const nextRaw = String(form.get("next") ?? "/");
  const next = safeNext(nextRaw);

  if (!process.env.FAMILY_PASSWORD_HASH) {
    return {
      ok: false as const,
      error: "auth-not-configured" as const,
      message:
        "FAMILY_PASSWORD_HASH is not set on the server. " +
        "Generate an argon2id hash and set it, then restart.",
    } satisfies LoginError;
  }

  // Validate the algorithm up front so a misconfigured hash produces a
  // clear error, not a silent verify-fail.
  try {
    assertHashIsArgon2id(process.env.FAMILY_PASSWORD_HASH);
  } catch (err) {
    return {
      ok: false as const,
      error: "auth-not-configured" as const,
      message: (err as Error).message,
    } satisfies LoginError;
  }

  const ok = await verifyPassword(password);
  if (!ok) {
    return {
      ok: false as const,
      error: "bad-password" as const,
      message: "That password didn't match. Try again.",
    } satisfies LoginError;
  }

  // On success: throw a redirect so React Router follows it. The
  // Set-Cookie header rides on the redirect so the browser stores the
  // session before following.
  throw redirect(next, {
    headers: { "Set-Cookie": buildSessionCookie() },
  });
}

export default function LoginRoute() {
  const [params] = useSearchParams();
  const next = params.get("next") ?? "/";
  const actionData = useActionData<LoginError>();

  return (
    <main
      style={{
        maxWidth: 380,
        margin: "10vh auto",
        padding: "1.5rem 1.25rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.5rem" }}>recipedb</h1>
      <p style={{ color: "#6b655c", margin: "0 0 1.25rem" }}>
        Enter the family password to continue.
      </p>
      <Form method="post" style={{ display: "grid", gap: 12 }}>
        <input type="hidden" name="next" value={next} />
        <label style={fieldLabelStyle}>
          Password
          <input
            type="password"
            name="password"
            autoFocus
            required
            autoComplete="current-password"
            style={inputStyle}
          />
        </label>
        <button type="submit" style={primaryBtn}>Sign in</button>
        {actionData ? (
          <p
            role="alert"
            style={{
              color:
                actionData.error === "auth-not-configured"
                  ? "#9a3030"
                  : "#a26800",
              fontSize: 13,
              margin: 0,
            }}
          >
            {actionData.message}
          </p>
        ) : null}
      </Form>
      <p style={{ color: "#8a8472", fontSize: 12, marginTop: 24 }}>
        Signed in sessions last 30 days. To change the password, generate
        a new argon2id hash and update <code>FAMILY_PASSWORD_HASH</code>{" "}
        on the server, then restart.
      </p>
      <p style={{ marginTop: 24, fontSize: 12 }}>
        <Link to="/health" style={{ color: "#8a8472" }}>health</Link>
      </p>
    </main>
  );
}

/**
 * Constrain the post-login redirect to a same-origin path. We accept
 * only paths that start with "/" and do not start with "//" (which the
 * browser would treat as a protocol-relative off-site URL).
 */
function safeNext(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  return raw;
}

const fieldLabelStyle: React.CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: 12,
  color: "#6b655c",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const inputStyle: React.CSSProperties = {
  border: "1px solid #c9c1b1",
  background: "#fff",
  borderRadius: 10,
  padding: "10px 12px",
  font: "inherit",
  color: "inherit",
  textTransform: "none",
  letterSpacing: "normal",
};

const primaryBtn: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #b04a2f",
  background: "#b04a2f",
  color: "#fff",
  borderRadius: 999,
  padding: "10px 18px",
  font: "inherit",
  cursor: "pointer",
};
