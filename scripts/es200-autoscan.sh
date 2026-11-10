#!/usr/bin/env bash
#
# es200-autoscan.sh — poll an Epson ES-200 ADF and save every sheet as JPEG.
#
# Uses the sane "epsonds" backend. The device is selected by backend name only
# (-d epsonds), so a re-plug that changes the libusb bus/address does not break
# the loop. Each poll drains the entire ADF feeder in one scanimage --batch run.
#
# No dependencies beyond scanimage + coreutils (flock/timeout are used only
# when present; a pidfile fallback covers systems without flock).

set -u
set -o pipefail
shopt -s nullglob

PROG=${0##*/}

# ---------------------------------------------------------------------------
# defaults (all overridable by environment)
# ---------------------------------------------------------------------------
SOURCE=${SOURCE:-"ADF Front"}
MODE=${MODE:-Color}
RESOLUTION=${RESOLUTION:-300}
INTERVAL=${INTERVAL:-2}
OUTDIR=${OUTDIR:-"$HOME/scans"}
SCAN_DEVICE=${SCAN_DEVICE:-epsonds}
SCAN_TIMEOUT=${SCAN_TIMEOUT:-1800}   # per-batch timeout (s), 0 disables
BACKOFF_MAX=${BACKOFF_MAX:-60}       # cap for error backoff (s)

VERBOSE=0
ONCE=0
RUN_DIR=
SCAN_PID=0
SLEEP_PID=0
LOCKFILE=
LOCK_MODE=
PIDFILE=

# ---------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
warn() { printf '[%s] WARNING: %s\n' "$(date '+%F %T')" "$*" >&2; }
vlog() { (( VERBOSE )) && printf '[%s] %s\n' "$(date '+%F %T')" "$*"; return 0; }
die()  { printf '[%s] ERROR: %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

usage() {
	cat <<EOF
Usage: $PROG [OPTIONS] [OUTDIR]

Poll an Epson ES-200 (sane epsonds backend) ADF and save each batch of pages
as timestamped JPEG files. Every trigger drains the whole feeder.

Options:
  --duplex                Scan both sides (same as --source "ADF Duplex")
  --source NAME           Sane source: "ADF Front" (default) or "ADF Duplex"
  --mode MODE             Lineart | Gray | Color          (default: Color)
  --resolution, -r DPI    200 | 300 | 400 | 600            (default: 300)
  --interval SECONDS      Idle poll interval in seconds    (default: 2)
  --outdir DIR            Output directory                 (default: ~/scans)
  --once                  Run a single poll and exit
                          (0 = pages saved or feeder empty, 1 = scan error)
  -v, --verbose           Verbose logging (idle polls, commands, progress)
  -h, --help              Show this help and exit

Environment:
  OUTDIR        Output directory (default: ~/scans); positional OUTDIR wins
  MODE          Lineart | Gray | Color
  RESOLUTION    200 | 300 | 400 | 600
  INTERVAL      Idle poll interval in seconds
  SOURCE        "ADF Front" or "ADF Duplex"
  SCAN_DEVICE   sane device name (default: epsonds)
  SCAN_TIMEOUT  Per-batch scan timeout in seconds, 0 disables (default: 1800)
  BACKOFF_MAX   Maximum error backoff in seconds (default: 60)

Output:
  Pages are stored as scan-YYYYMMDD-HHMMSS-p###.jpg — the timestamp is taken
  once per batch, ### is the page number within that batch.

Empty feeder:
  scanimage exits non-zero with a "No document"/"out of documents" style
  message when the ADF is empty. That case is treated as idle and retried
  quietly (logged only with --verbose). Genuine errors are logged as warnings
  with exponential backoff.

Examples:
  $PROG                              # color 300dpi duplex? no: ADF Front
  $PROG --duplex --resolution 400 --mode Color
  $PROG --mode Gray --interval 5 /mnt/scans
  $PROG --once -v                    # one poll, useful for tests/systemd

Exit status:
  0  normal shutdown, or --once found no pages / saved pages
  1  startup error, usage error, or --once hit a real scan error
  130/143  interrupted by SIGINT/SIGTERM
EOF
}

# ---------------------------------------------------------------------------
# cleanup / signals
# ---------------------------------------------------------------------------
cleanup() {
	if (( SCAN_PID > 0 )); then
		kill -TERM "$SCAN_PID" 2>/dev/null || true
		# GNU timeout relays TERM to scanimage; give it a moment, then force.
		local i
		for i in 1 2 3 4 5; do
			kill -0 "$SCAN_PID" 2>/dev/null || break
			sleep 0.1 2>/dev/null || break
		done
		kill -KILL "$SCAN_PID" 2>/dev/null || true
	fi
	if (( SLEEP_PID > 0 )); then
		kill "$SLEEP_PID" 2>/dev/null || true
	fi
	if [[ -n $RUN_DIR && -d $RUN_DIR ]]; then
		rm -rf -- "$RUN_DIR"
	fi
	if [[ $LOCK_MODE == pidfile && -n $PIDFILE && -f $PIDFILE ]]; then
		local owner
		owner=$(cat -- "$PIDFILE" 2>/dev/null || true)
		[[ $owner == "$$" ]] && rm -f -- "$PIDFILE"
	fi
	return 0
}

on_signal() {
	local sig=$1 code=$2
	log "received SIG$sig, shutting down"
	# cleanup runs from the EXIT trap
	exit "$code"
}

trap cleanup EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------
need_arg() {
	[[ $# -ge 2 && -n $2 ]] || die "option $1 requires an argument (see --help)"
}

normalize_mode() {
	case ${1,,} in
		color|colour) printf 'Color\n' ;;
		gray|grey)    printf 'Gray\n' ;;
		lineart|line) printf 'Lineart\n' ;;
		*) return 1 ;;
	esac
}

normalize_source() {
	case ${1,,} in
		"adf front"|front|adf-front|adf_front)   printf 'ADF Front\n' ;;
		"adf duplex"|duplex|adf-duplex|adf_duplex) printf 'ADF Duplex\n' ;;
		*) printf '%s\n' "$1" ;;
	esac
}

POSITIONAL=()
while (( $# )); do
	case $1 in
		--duplex)          SOURCE="ADF Duplex"; shift ;;
		--source)          need_arg "$@"; SOURCE=$2; shift 2 ;;
		--mode)            need_arg "$@"; MODE=$2; shift 2 ;;
		--resolution|-r)   need_arg "$@"; RESOLUTION=$2; shift 2 ;;
		--interval)        need_arg "$@"; INTERVAL=$2; shift 2 ;;
		--outdir|--out-dir|-o) need_arg "$@"; OUTDIR=$2; shift 2 ;;
		--once)            ONCE=1; shift ;;
		-v|--verbose)      VERBOSE=1; shift ;;
		-h|--help)         usage; exit 0 ;;
		--)                shift; while (( $# )); do POSITIONAL+=("$1"); shift; done ;;
		-*)                die "unknown option: $1 (see --help)" ;;
		*)                 POSITIONAL+=("$1"); shift ;;
	esac
done

if (( ${#POSITIONAL[@]} > 1 )); then
	die "too many arguments: ${POSITIONAL[*]} (see --help)"
elif (( ${#POSITIONAL[@]} == 1 )); then
	OUTDIR=${POSITIONAL[0]}
fi

# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------
MODE=$(normalize_mode "$MODE") || die "invalid mode '$MODE' (Lineart|Gray|Color)"
SOURCE=$(normalize_source "$SOURCE")

case $RESOLUTION in
	200|300|400|600) ;;
	*) die "invalid resolution '$RESOLUTION' (200|300|400|600)" ;;
esac

[[ $INTERVAL =~ ^[0-9]+$ ]] && (( INTERVAL >= 1 )) \
	|| die "invalid interval '$INTERVAL' (integer seconds >= 1)"
[[ $BACKOFF_MAX =~ ^[0-9]+$ ]] && (( BACKOFF_MAX >= 1 )) \
	|| die "invalid BACKOFF_MAX '$BACKOFF_MAX' (integer seconds >= 1)"
[[ $SCAN_TIMEOUT =~ ^[0-9]+$ ]] \
	|| die "invalid SCAN_TIMEOUT '$SCAN_TIMEOUT' (integer seconds, 0 disables)"

case $SOURCE in
	"ADF Front"|"ADF Duplex") ;;
	*) warn "unusual source '$SOURCE' (ES-200 supports 'ADF Front' and 'ADF Duplex')" ;;
esac

# Expand a leading ~ and normalise OUTDIR to an absolute path.
OUTDIR=${OUTDIR/#\~/$HOME}
mkdir -p -- "$OUTDIR" || die "cannot create output directory: $OUTDIR"
OUTDIR=$(cd -- "$OUTDIR" && pwd) || die "cannot resolve output directory: $OUTDIR"
[[ -w $OUTDIR ]] || die "output directory is not writable: $OUTDIR"

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------
command -v scanimage >/dev/null 2>&1 || die "scanimage not found (install sane-utils)"

RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/es200-autoscan.XXXXXX") \
	|| die "cannot create temporary directory"
trap cleanup EXIT

# ---------------------------------------------------------------------------
# single-instance lock
# ---------------------------------------------------------------------------
acquire_lock() {
	local lockbase=${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}
	LOCKFILE="$lockbase/es200-autoscan-$UID.lock"

	if command -v flock >/dev/null 2>&1; then
		exec 9>>"$LOCKFILE" || die "cannot open lock file: $LOCKFILE"
		if ! flock -n 9; then
			# The pid in the lock file is only meaningful if that process is
			# still alive and is actually another copy of this script.
			local holder='' recorded=''
			recorded=$(cat -- "$LOCKFILE" 2>/dev/null || true)
			if [[ $recorded =~ ^[0-9]+$ ]] && kill -0 "$recorded" 2>/dev/null; then
				if grep -qs 'es200-autoscan' "/proc/$recorded/cmdline" 2>/dev/null; then
					holder=$recorded
				fi
			fi
			die "another instance is already running${holder:+ (pid $holder)}: $LOCKFILE"
		fi
		# Safe to truncate now that the lock is held.
		printf '%s\n' "$$" >"$LOCKFILE"
		LOCK_MODE=flock
		vlog "acquired flock $LOCKFILE"
		return 0
	fi

	# Fallback: pidfile with liveness check.
	PIDFILE="$LOCKFILE.pid"
	LOCK_MODE=pidfile
	if [[ -f $PIDFILE ]]; then
		local owner
		owner=$(cat -- "$PIDFILE" 2>/dev/null || true)
		if [[ $owner =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
			die "another instance is already running (pid $owner): $PIDFILE"
		fi
		warn "removing stale pid file $PIDFILE (pid ${owner:-unknown})"
	fi
	printf '%s\n' "$$" >"$PIDFILE" || die "cannot write pid file: $PIDFILE"
	vlog "acquired pidfile $PIDFILE"
}
acquire_lock

# ---------------------------------------------------------------------------
# scanning
# ---------------------------------------------------------------------------
# Empty-feeder diagnostics from sane/epsonds. Deliberately does NOT match
# "paper jam" or "cover open" — those are real errors deserving a warning.
EMPTY_RE='no document|no documents|out of paper|out of documents|no paper|document feeder.*(empty|no )|adf.*(empty|out of|no paper|no document)|feeder.*empty|no more (pages|documents)|end of document|scanner.*empty'

save_batch() {
	local stamp saved=0 src base num n dest
	stamp=$(date '+%Y%m%d-%H%M%S')

	for src in "$@"; do
		base=${src##*/}
		num=${base#batch-}
		num=${num%.jpg}
		dest="$OUTDIR/scan-$stamp-p$num.jpg"

		# Guard against a second batch landing in the same second.
		if [[ -e $dest ]]; then
			n=2
			while [[ -e "$OUTDIR/scan-$stamp-p$num-$n.jpg" ]]; do
				n=$(( n + 1 ))
			done
			dest="$OUTDIR/scan-$stamp-p$num-$n.jpg"
		fi

		if mv -f -- "$src" "$dest"; then
			saved=$(( saved + 1 ))
			log "saved $dest"
		else
			warn "could not move $src -> $dest"
		fi
	done

	log "batch complete: $saved page(s) -> $OUTDIR"
	return 0
}

show_scan_stderr() {
	local line
	while IFS= read -r line; do
		[[ -n $line ]] && warn "scanimage: ${line#scanimage: }"
	done < <(head -n 5 -- "$RUN_DIR/scan.err" 2>/dev/null)
	return 0
}

# One poll. Returns 0 for "pages saved" or "feeder empty"; 1 for real errors.
poll_once() {
	local rc=0
	local -a cmd pages good

	rm -f -- "$RUN_DIR"/batch-*.jpg
	: >"$RUN_DIR/scan.out"
	: >"$RUN_DIR/scan.err"

	cmd=(scanimage -d "$SCAN_DEVICE"
		--source "$SOURCE"
		--mode "$MODE"
		--resolution "$RESOLUTION"
		--format=jpeg
		--batch="$RUN_DIR/batch-%03d.jpg"
		--batch-print)
	(( VERBOSE )) && cmd+=(--progress)

	vlog "running: ${cmd[*]}"

	if (( SCAN_TIMEOUT > 0 )) && command -v timeout >/dev/null 2>&1; then
		timeout --signal=TERM --kill-after=15 "$SCAN_TIMEOUT" "${cmd[@]}" \
			>"$RUN_DIR/scan.out" 2>"$RUN_DIR/scan.err" &
	else
		"${cmd[@]}" >"$RUN_DIR/scan.out" 2>"$RUN_DIR/scan.err" &
	fi
	SCAN_PID=$!
	wait "$SCAN_PID"
	rc=$?
	SCAN_PID=0

	pages=("$RUN_DIR"/batch-*.jpg)
	good=()
	for f in "${pages[@]}"; do
		if [[ -s $f ]]; then
			good+=("$f")
		else
			warn "discarding zero-length page: $f"
			rm -f -- "$f"
		fi
	done

	if (( ${#good[@]} > 0 )); then
		save_batch "${good[@]}"
		if (( rc != 0 )); then
			if (( rc == 124 || rc == 137 )); then
				warn "scan timed out after ${SCAN_TIMEOUT}s; saved ${#good[@]} page(s)"
			else
				warn "scan ended with exit code $rc after ${#good[@]} page(s)"
			fi
			show_scan_stderr
			return 1
		fi
		return 0
	fi

	# No pages produced.
	if (( rc == 0 )); then
		vlog "ADF produced no pages (feeder empty)"
		return 0
	fi

	if (( rc == 124 || rc == 137 )); then
		warn "scan timed out after ${SCAN_TIMEOUT}s with no pages produced"
		show_scan_stderr
		return 1
	fi

	if grep -qiE "$EMPTY_RE" -- "$RUN_DIR/scan.err" 2>/dev/null; then
		vlog "ADF empty (exit $rc): $(head -n 1 -- "$RUN_DIR/scan.err" 2>/dev/null)"
		return 0
	fi

	warn "scan failed with exit code $rc"
	show_scan_stderr
	return 1
}

# Interruptible sleep so SIGINT/SIGTERM are handled promptly.
nap() {
	sleep "$1" &
	SLEEP_PID=$!
	wait "$SLEEP_PID" 2>/dev/null || true
	SLEEP_PID=0
	return 0
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
log "watching $SCAN_DEVICE ($SOURCE, $MODE, ${RESOLUTION}dpi, every ${INTERVAL}s) -> $OUTDIR"
vlog "pid $$, tmp $RUN_DIR, lock ${LOCKFILE:-none} (${LOCK_MODE})"
[[ $SOURCE == "ADF Duplex" ]] && log "duplex mode: fronts and backs are scanned alternately"

if (( ONCE )); then
	if poll_once; then
		exit 0
	else
		exit 1
	fi
fi

fails=0
while :; do
	if poll_once; then
		fails=0
		vlog "idle, next poll in ${INTERVAL}s"
		nap "$INTERVAL"
	else
		fails=$(( fails + 1 ))
		shift_n=$(( fails < 6 ? fails : 6 ))
		backoff=$(( INTERVAL * (1 << shift_n) ))
		(( backoff > BACKOFF_MAX )) && backoff=$BACKOFF_MAX
		(( backoff < INTERVAL )) && backoff=$INTERVAL
		warn "retrying in ${backoff}s (consecutive failure $fails)"
		nap "$backoff"
	fi
done
