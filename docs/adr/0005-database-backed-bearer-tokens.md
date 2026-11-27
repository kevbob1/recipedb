# ADR-0005: Database-backed named bearer tokens

Date: 2026-11-26
Status: Accepted

## Context

Browser sessions are deliberately stateless HMAC cookies: they require no
database lookup and have no rotation mechanism. A stateless bearer token would
match that design, but could not be revoked; a leaked script token would require
rotating the household password. Named tokens need a revocation path that does
not disturb browser sessions.

## Decision

Store named bearer tokens in an `api_tokens` table. Minting generates a
`rdb_`-prefixed, random 32-byte base64url secret; only its SHA-256 hash is
stored, and the plaintext is shown once. `POST /api/tokens` mints tokens only
for a request authenticated by the browser session cookie. When no session
cookie is present, `requireAuth` verifies a supplied bearer token against the
stored hash.

Tokens have one privilege tier: a token grants the same power as a full session,
including access to operator routes. They have no expiry, scopes, or
rate-limiting. Revocation deletes the token's row.

## Considered Options

- **Stateless bearer token:** rejected. It would preserve the session design's
  symmetry, but offers no individual revocation; compromise would force a
  household password rotation.
- **Database-backed tokens:** chosen because revocation matters more than
  symmetry with the deliberately stateless browser session.

## Consequences

- Bearer-authenticated requests query SQLite; browser login and logout remain
  unchanged.
- The single-household threat model accepts full-session bearer-token power,
  including operator access, and the absence of expiry, scopes, and
  rate-limiting.
- A token can be revoked independently by deleting its row.
