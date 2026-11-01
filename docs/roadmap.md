# Roadmap

Status as of 2026-11-01, from a feature-gap review against similar
products (Mealie, Tandoor, Paprika, Mela, SuperCook, Copy Me That,
RecipeSage, KitchenOwl, Cookidoo, Samsung Food/Whisk, Nextcloud
Cookbook). Feature designs are fixed in `docs/adr/0003`.

## Build next, in order

1. **Display-time unit conversion** — ADR-0003 A. US ⇄ metric toggle,
   same-dimension only, fractions preserved. No schema change.
2. **"What can I cook?" filter** — ADR-0003 B+C. Home-page ingredient
   chips, ranked by fewest missing, hard-coded staple exemptions.
3. **Backup CronJob (disaster recovery)** — nightly k8s CronJob runs a
   SQLite-safe backup (sqlite3 `.backup` API or equivalent — never a
   raw file copy over a live WAL, per the docker-era gotcha), ships
   the result to `root@prox6:/srv/recipedb/backups/`, retains 14
   days. This is the only accepted insurance for the k8s PVC, which
   currently has no backup at all (`recipedb-backup.timer` was
   disabled at the k8s migrate and never replaced). An in-app
   export/import feature was declined; this covers disaster recovery
   only.

## Deliberately declined (2026-11-01)

Recorded so they are not silently re-proposed; reopen only with new
household evidence.

| Feature | Why not |
|---|---|
| Shopping list | Noted as table-stakes everywhere, but this household cooks from memory; declined. |
| Meal planner | Same. No weekly grid, no ICS. |
| Pantry inventory | Data-entry burden kills pantry apps; declined before design. |
| In-app export/import | Backup CronJob covers disaster recovery; export is a feature, declined. |
| Step-text timers | Cook mode + wake-lock is enough; no auto-parsed countdowns. |
| Ratings | Favorite boolean suffices for one household. |
| Offline / PWA | LAN-first usage; SSR is fine. |
| Nutrition auto-calc | Food-DB maintenance cost outweighs value; eyeballing works. |
| Exclusion filters ("without X") | Declined for v1 reverse search. |
| User-editable staples list | Rejected in favour of a hard-coded list (ADR-0003 C). |
| Duplicate merge | Still out of scope per GLOSSARY. |

## Competitive notes (why these and not more)

- Pantry + deduct-on-shop is the strongest differentiator in paid
  apps (Paprika) and absent from self-hosted peers — consciously
  skipped, not overlooked.
- Mela's RSS blog-feed inbox has no self-hosted equivalent; niche,
  skipped.
- Tandoor's USDA nutrition and cost tracking, ICS calendar export,
  and Home Assistant hooks: power-user scope, skipped.
