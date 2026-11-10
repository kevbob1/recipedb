# Scanner ingest (Epson ES-200)

`scripts/es200-autoscan.sh` polls an Epson ES-200 ADF through the SANE
`epsonds` backend and saves each batch as JPEG files. Those files are the input
to the existing multi-image upload — no app code is involved here.

## Prerequisites

- `scanimage` from **sane-utils** on the host with USB access to the scanner.
  It is *not* installed in the Node/dev container image.
- The device is addressed by backend name only (`-d epsonds`), so re-plugging
  the scanner (new libusb bus/address) does not break the loop.

## Flags and environment

| Flag | Env | Values / default |
|---|---|---|
| `--source NAME` | `SOURCE` | `ADF Front` (default), `ADF Duplex` |
| `--duplex` | — | shorthand for `--source "ADF Duplex"` |
| `--mode MODE` | `MODE` | `Lineart` \| `Gray` \| `Color` (default `Color`) |
| `-r`, `--resolution DPI` | `RESOLUTION` | `200`/`300`/`400`/`600` (default `300`) |
| `--interval SECONDS` | `INTERVAL` | idle poll interval, default `2` |
| `-o`, `--outdir DIR` | `OUTDIR` | default `~/scans` (positional `OUTDIR` also works) |
| — | `SCAN_DEVICE` | `epsonds` (default) |
| — | `SCAN_TIMEOUT` / `BACKOFF_MAX` | per-batch timeout `1800`s / error backoff cap `60`s |
| `--once` | — | one poll, then exit (`0` = pages saved or feeder empty, `1` = scan error) |

One instance only: a per-UID lock is taken under `$XDG_RUNTIME_DIR` (or `/tmp`).

## Output contract

Each page is written to `OUTDIR` as `scan-YYYYMMDD-HHMMSS-p###.jpg` — the
timestamp is taken once per batch and `###` is the page number within it.
Point the multi-image upload at that directory after a batch completes.

## Running it

```bash
scripts/es200-autoscan.sh --duplex --resolution 400 ~/scans   # continuous
scripts/es200-autoscan.sh --once -v                            # single poll, for tests/timers
```

Continuous example for systemd:

```ini
[Service]
ExecStart=/home/kev/git/recipedb/scripts/es200-autoscan.sh --source "ADF Front"
Restart=on-failure
Environment=OUTDIR=/home/kev/scans
```

## Empty feeder

With an empty ADF `scanimage` exits non-zero with a "No document" / "out of
documents" style message. That is treated as idle and silently retried after
`INTERVAL`; genuine failures (paper jam, cover open, timeout) log a warning and
back off exponentially, capped by `BACKOFF_MAX`.
