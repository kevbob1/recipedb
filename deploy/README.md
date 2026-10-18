# recipedb operations

## Deployment targets — standing decision (2026-10-18)

Two targets, no others:

| Target | Role | Entry point |
| --- | --- | --- |
| **k8s (helm)** | production, the house-facing deployment | `deploy/k8s/deploy.sh`, chart `helm/recipedb` |
| **local container** | dev + verification only | `deploy/run-container.sh` with a local `RECIPEDB_BASE` |

**Docker-on-prox6 is retired and is never a deployment target again.** On
2026-10-18 its dataset (1 recipe, 15 ingredient lines, 1 image) was migrated
into PVC `recipedb-data` and verified there, the container was removed, and
`recipedb-backup.timer` was disabled. The host data is kept as a cold archive
at `/srv/recipedb/retired-20261018-data/` (plus `/srv/recipedb/{data,backups}`)
— do not delete it.

## Retired: docker on prox6 (historical runbook, reference only)

> Kept for the archive and for the parts that still apply to a local
> container. Nothing here runs on prox6 any more.

Single container, `docker run` only (no compose, no reverse proxy, no TLS).
LAN access was at `http://prox6:3000`. Image: `recipedb:0.1`.

Paths on the host:

| Path | Purpose |
| --- | --- |
| `/srv/recipedb/data` | `/data` volume: `recipes.db`, WAL/SHM, `images/`, `migrations-applied.json` |
| `/srv/recipedb/backups` | nightly DB copies and images tarballs |
| `/srv/recipedb/restore-drill` | scratch dir for the restore drill |
| `/srv/recipedb/env` | container env file, `chmod 600`, **not in the repo** |

Scripts live in this `deploy/` directory and are installed to
`/srv/recipedb/` (`run-container.sh` bind-mounts `/srv/recipedb/backup.cjs`
into the container at `/app/backup.cjs`, so it must sit next to the scripts).

## First install

On the build machine, build and ship the image:

```sh
docker build -t recipedb:0.1 .
docker save recipedb:0.1 | ssh prox6 docker load
```

On prox6:

```sh
sudo install -d -m 755 /srv/recipedb /srv/recipedb/backups
sudo install -m 600 deploy/recipedb.env.example /srv/recipedb/env
sudo $EDITOR /srv/recipedb/env        # set hash + secret, see comments in the file
sudo install -m 755 deploy/run-container.sh /srv/recipedb/run-container.sh
sudo install -m 755 deploy/restore-drill.sh /srv/recipedb/restore-drill.sh
sudo install -m 644 deploy/backup.cjs /srv/recipedb/backup.cjs
sudo install -m 755 deploy/backup.sh /srv/recipedb/backup.sh
sudo /srv/recipedb/run-container.sh
```

`run-container.sh [image]` creates the data/backup dirs, chowns the data volume
to uid 1000 (the image's `node` user), removes the existing `recipedb`
container, starts it, and fails with the container logs if `/health` does not
turn `ok` within 30s.

Point the phone at `http://prox6:3000`. The live camera stream
(`getUserMedia`) requires a secure context, so on plain HTTP use the
"Or pick an image file" path — that opens the native camera on mobile.

## Updates

```sh
docker build -t recipedb:0.1 .
docker save recipedb:0.1 | ssh prox6 docker load
ssh prox6 sudo /srv/recipedb/run-container.sh recipedb:0.1
```

Migrations run on container start, before the server listens. The `data`
volume is reused, so no data is copied.

## Backups

Installed as a systemd timer at 03:30 daily (random delay up to 5 min):

```sh
sudo install -m 755 deploy/backup.sh /srv/recipedb/backup.sh
sudo install -m 644 deploy/backup.cjs /srv/recipedb/backup.cjs
sudo install -m 644 deploy/recipedb-backup.service /etc/systemd/system/
sudo install -m 644 deploy/recipedb-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now recipedb-backup.timer
```

Run one by hand and inspect the result:

```sh
sudo /srv/recipedb/backup.sh
ls -lh /srv/recipedb/backups
journalctl -u recipedb-backup.service -n 50
```

Backups are `recipes-YYYYMMDD.db` (made with better-sqlite3's `db.backup()` via
`docker exec` in the live container, so it sees the same WAL/SHM files the app
is writing), `images-YYYYMMDD.tar.gz`, and `migrations-applied-YYYYMMDD.json`
(the journal is part of the restorable state — without it the app replays
`0000_init` and exits at boot). Files older than 7 days are pruned.

## Restore drill

Proves the newest backup boots: copies the DB **and** the migration journal to
`/srv/recipedb/restore-drill/data`, extracts the images tarball, starts
`recipedb-drill` on port 3001, checks `/health` (`db: ok`), the auth redirect
(`/` → 302 `/login`), and integrity + row counts. It always removes the drill
container and prints PASS/FAIL.

```sh
sudo /srv/recipedb/restore-drill.sh
```

## Real restore

```sh
sudo docker stop recipedb
sudo cp -a /srv/recipedb/data /srv/recipedb/data.before-restore
sudo rm -f /srv/recipedb/data/recipes.db-wal /srv/recipedb/data/recipes.db-shm
sudo cp /srv/recipedb/backups/recipes-YYYYMMDD.db /srv/recipedb/data/recipes.db
sudo cp /srv/recipedb/backups/migrations-applied-YYYYMMDD.json /srv/recipedb/data/migrations-applied.json

# optional: images from the matching tarball
sudo tar -xzf /srv/recipedb/backups/images-YYYYMMDD.tar.gz -C /srv/recipedb/data

sudo /srv/recipedb/run-container.sh
curl -fsS http://prox6:3000/health
```

`run-container.sh` recreates the container, so a plain `docker start` is not
needed. Delete `/srv/recipedb/data.before-restore` once the restore is verified.

## Kitchen verification (the last mile)

Deployed and machine-verified: image `recipedb:0.1`, container `recipedb` on
prox6 (port 3000), `--restart unless-stopped`, nightly backup timer enabled,
restore drill PASS.

What only a human at the counter can confirm:

1. On a phone on the home Wi-Fi, open `http://prox6:3000` (or
   `http://192.168.0.6:3000`) and log in with the family password.
2. Add a recipe from a URL (`Add → Get it → paste a link → Review → Saved`) and
   check the review screen shows title, ingredients, and steps.
3. Add a recipe from a photo of a printout: tap **Or pick an image file**
   (this opens the phone camera; the in-page **Use camera** preview needs HTTPS
   and will show "Couldn't access the camera" on plain HTTP).
4. Search for the new recipe from the home screen and open it.
5. Tell the next wayfinder session if anything above did not work.

To rotate the family password: generate a new argon2id hash, edit
`/srv/recipedb/env`, then `sudo /srv/recipedb/run-container.sh` (a new
`SESSION_SECRET` invalidates every existing cookie, so everyone logs in again).
For the production deployment, set the hash in
`~/.config/recipedb/k8s-secrets.yaml` and run `deploy/k8s/deploy.sh` instead;
a new `SESSION_SECRET` there likewise invalidates every existing cookie.

## Kubernetes (helm) — the only production path (#21)

The house-facing deployment — and the **only** production target since
2026-10-18 — is the helm release `recipedb` in namespace `default` on the
prox6 cluster, reachable at **https://recipedb.k.pd.o**
(and https://recipedb.p.drule.org). `deploy/run-container.sh` remains for
local dev/verification only.

Chart: `helm/recipedb` (values.yaml documents each block).
Deploy: `deploy/k8s/deploy.sh` — buildx builds and pushes
`registry.k.pd.o/recipedb:<UTC-timestamp>`, then `helm upgrade --install`
with `~/.config/recipedb/k8s-secrets.yaml` (mode 0600, kept outside the repo;
copy `helm/recipedb/secrets.example.yaml`). Manual equivalent:

```bash
docker buildx build --push --platform linux/amd64 -t registry.k.pd.o/recipedb:<tag> .
helm upgrade --install recipedb ./helm/recipedb -n default \
  -f ./helm/recipedb/values.yaml -f ~/.config/recipedb/k8s-secrets.yaml \
  --set image.repository=registry.k.pd.o/recipedb,image.tag=<tag> \
  --wait --timeout 5m
```

Things this deployment does differently from the other charts in the cluster,
all because SQLite is a single-writer store:

- **1 replica, Recreate strategy, no HPA.** `/data` (recipes.db + WAL, images/,
  migrations-applied.json) lives on a ReadWriteOnce PVC (`recipedb-data`, 5Gi,
  local-path). Two pods must never share it.
- **The PVC is annotated `helm.sh/resource-policy: keep`** — `helm uninstall`
  will not delete the recipes. Delete the PVC by hand if you really mean it.
- **No migration Job.** `server.js` runs `bootstrap()` → `runMigrations()`
  before it starts listening, using the journal in `/data`, so a pre-install
  hook Job (what pharmsim uses for prisma) would only race the pod for the
  volume.
- **Secrets:** no SOPS in this repo; `FAMILY_PASSWORD_HASH` + `SESSION_SECRET`
  come from the operator's secret values file. `helm template` fails if either
  is empty.
- **Secure cookie:** the app sets `Secure` when the request arrives over TLS
  (`X-Forwarded-Proto` from the nginx ingress), so HTTPS logins get a Secure
  cookie while the plain-HTTP LAN fallback keeps working. `COOKIE_SECURE=1`
  forces it on.
- **TLS:** `recipedb.k.pd.o` is served by the ingress controller's default
  certificate (`default/k.pd.o-cert`, SAN `*.k.pd.o`); `recipedb.p.drule.org`
  uses the `wildcard-domain-tls` (cert-manager) secret named in the ingress.

Logs / health: `kubectl -n default logs deploy/recipedb -f`,
`curl https://recipedb.k.pd.o/health`.
