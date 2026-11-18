#!/usr/bin/env bash
# DeonTech Pulse — "Back up now", run as root by pulse-action.sh.
#
#   pulse-backup.sh <app> <offsite 0|1> <request-id>
#
# What each app's backup holds is written HERE, not sent by Pulse: Pulse can
# only name an app from this list, never a path. Plans:
#
#   aotc-track      its records: data/ (databases snapshotted), uploads,
#                   document-files, marriage-files, minutes
#   smart-deontech  data/ and public/uploads
#   ginasangel      /opt/ginasangel/data and app/public/uploads
#   ifaima          runs IFAIMA's own verified backup (ifaima-backup.service)
#   pledge          MySQL database pledgedb (dump)
#   pman            MySQL database pmandb (dump)
#   mysql           every MySQL database that is not a system one (dumps)
#   mssql-server    every SQL Server user database (BACKUP DATABASE … WITH
#                   CHECKSUM, COPY_ONLY), using the login in /etc/pulse-mssql.cnf
#                   (root-only; made by scripts/set-mssql-login.sh)
#   pulse           Pulse itself: /var/lib/pulse (its database snapshotted,
#                   settings). Not /etc/pulse.env: secrets never leave the server.
#   rondoq          runs RondoQ's own checked backup (rondoq-backup.service:
#                   database dump read back with pg_restore, uploads, and its
#                   ENCRYPTED off-site copy once RondoQ's key exists). Pulse
#                   keeps a local copy and records RondoQ's off-site result; it
#                   never sends RondoQ's data off-site itself (owner, 16 Nov:
#                   RondoQ's off-site copies are encrypted).
#   postgresql      every PostgreSQL database in every running cluster
#                   (pg_dump, custom format, read back with pg_restore --list),
#                   except those an app plan covers (rondoq). Off-site like MySQL.
#
# RondoQ deletes a closed organisation for good 30 days after deletion and its
# nightly dumps 30 days later; Pulse's copies of RondoQ (rondoq, postgresql)
# are therefore never kept longer than 30 days.
#
# SQLite databases are copied with sqlite3's online .backup (safe while the
# app is running), then checked with PRAGMA integrity_check. MySQL dumps use
# --single-transaction and must end with "Dump completed". The archive must
# then open (gzip -t, tar -t). Only then is the backup counted as good.
#
# Archives: /var/backups/pulse/<app>/<app>-<stamp>.tar.gz, root-only (0600),
# the newest 14 kept. The result is one JSON line appended to
# /var/lib/pulse-scan/backups/<app>.jsonl, which Pulse reads. Pulse never
# reads the archives themselves.
#
# Off-site: the archive is copied with rclone, as the deploy user (who owns the
# rclone config, as in /usr/local/bin/aotc-offsite-backup.sh), to
# <remote><Folder>/Backups/ on each remote in OFFSITE_REMOTES.
set -uo pipefail
export LC_ALL=C

APP="${1:-}"; OFFSITE="${2:-0}"; RID="${3:-manual}"
P="${PULSE_BACKUP_PREFIX:-}"                                  # tests: a fake filesystem root
DEST_ROOT="${PULSE_BACKUP_DEST:-$P/var/backups/pulse}"
MAN_DIR="${PULSE_BACKUP_MANIFEST:-/var/lib/pulse-scan/backups}"
KEEP="${PULSE_BACKUP_KEEP:-14}"
SQLITE3="${PULSE_BACKUP_SQLITE3:-sqlite3}"
MYSQLDUMP="${PULSE_BACKUP_MYSQLDUMP:-mysqldump}"
MYSQL="${PULSE_BACKUP_MYSQL:-mysql}"
SQLCMD="${PULSE_BACKUP_SQLCMD:-}"
MSSQL_CNF="${PULSE_BACKUP_MSSQL_CNF:-$P/etc/pulse-mssql.cnf}"
MSSQL_DIR="${PULSE_BACKUP_MSSQL_DIR:-$P/var/opt/mssql/data}"
RQ_BACKUPS="${PULSE_BACKUP_RONDOQ_DIR:-$P/var/backups/rondoq}"
PG_RESTORE="${PULSE_BACKUP_PG_RESTORE:-pg_restore}"
PG_LSCLUSTERS="${PULSE_BACKUP_PG_LSCLUSTERS:-pg_lsclusters}"
PG_BIN="${PULSE_BACKUP_PG_BIN:-/usr/lib/postgresql}"          # <ver>/bin/pg_dump, psql
AS_PG="${PULSE_BACKUP_AS_POSTGRES:-runuser -u postgres --}"
PG_SKIP="${PULSE_BACKUP_PG_SKIP:-rondoq}"                      # databases an app plan covers
SYSTEMCTL="${PULSE_BACKUP_SYSTEMCTL:-systemctl}"
RCLONE="${PULSE_BACKUP_RCLONE:-runuser -u deploy -- rclone}"
OFFSITE_REMOTES="${PULSE_BACKUP_REMOTES:-onedrive: minutes:}"
ROOT_UID="${PULSE_ACTION_ROOT_UID:-0}"

[[ $APP =~ ^[a-z0-9-]{1,40}$ ]] || { echo "Not an app name."; exit 2; }
[[ $OFFSITE == 0 || $OFFSITE == 1 ]] || { echo "Off-site must be 0 or 1."; exit 2; }
[[ $RID =~ ^[a-z0-9]{1,32}$ ]] || RID=manual

# ---- the plans --------------------------------------------------------------
DIRS=(); DBS=(); METHOD=files; FOLDER=""; EXCL=(); MAX_DAYS=""; OWN_OFFSITE=0
case "$APP" in
  aotc-track)     FOLDER=AOTC-Track;     DIRS=("$P/opt/aotc-track/data" "$P/opt/aotc-track/public/uploads" "$P/opt/aotc-track/document-files" "$P/opt/aotc-track/marriage-files" "$P/opt/aotc-track/minutes") ;;
  smart-deontech) FOLDER=Smart-DeonTech; DIRS=("$P/opt/smart-deontech/data" "$P/opt/smart-deontech/public/uploads") ;;
  ginasangel)     FOLDER=GinasAngel-Hub; DIRS=("$P/opt/ginasangel/data" "$P/opt/ginasangel/app/public/uploads") ;;
  ifaima)         FOLDER=IFAIMA;         METHOD=ifaima ;;
  pledge)         FOLDER=Pledges;        METHOD=mysql; DBS=(pledgedb) ;;
  pman)           FOLDER=Pman;           METHOD=mysql; DBS=(pmandb) ;;
  mysql)          FOLDER=Databases;      METHOD=mysql; DBS=(__all__) ;;
  mssql-server)   FOLDER=SQL-Server;     METHOD=mssql ;;
  rondoq)         FOLDER=RondoQ;         METHOD=rondoq; MAX_DAYS=30; OWN_OFFSITE=1 ;;
  postgresql)     FOLDER=PostgreSQL;     METHOD=postgres; MAX_DAYS=30 ;;
  # The country table and its cache are downloaded again by pulse-geoip.timer.
  pulse)          FOLDER=DeonTech-Pulse; DIRS=("$P/var/lib/pulse"); EXCL=(--exclude='*.csv' --exclude='*.csv.gz' --exclude='*geoip*' --exclude='*/actions') ;;
  *) echo "Pulse has no backup plan for $APP."; exit 2 ;;
esac

STAMP="$(date -u +%Y%m%d-%H%M%S)"
START=$(date +%s)
OUTDIR="$DEST_ROOT/$APP"
install -d -m 0700 "$DEST_ROOT" "$OUTDIR" 2>/dev/null || mkdir -p "$OUTDIR"
WORK="$(mktemp -d "$OUTDIR/.work-XXXXXX")" || { echo "Cannot make a work folder in $OUTDIR."; exit 1; }
trap 'rm -rf "$WORK" "$ERRF"' EXIT
ERRF="$(mktemp "$OUTDIR/.err-XXXXXX")"
CHECKS=(); ERR=""
check() { CHECKS+=("$1"); echo "  ✓ $1"; }
fail() { ERR="$1"; echo "  ✗ $1"; }
jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }

echo "Backing up $APP ($METHOD) …"

# ---- files + SQLite ----------------------------------------------------------
backup_files() {
  local d rel list=()
  for d in "${DIRS[@]}"; do
    [ -e "$d" ] || { echo "  · $d is not there (skipped)"; continue; }
    d="$(readlink -f "$d")"                  # blue/green lines link to the records
    list+=("$d")
    # Databases: an online snapshot each, never a raw copy of a live file.
    while IFS= read -r -d '' db; do
      rel="${db#/}"
      mkdir -p "$WORK/databases/$(dirname "$rel")"
      if "$SQLITE3" "$db" ".timeout 20000" ".backup '$WORK/databases/$rel'" 2>"$ERRF"; then
        local r; r="$("$SQLITE3" "$WORK/databases/$rel" 'PRAGMA integrity_check;' 2>&1 | head -1)"
        if [ "$r" = ok ]; then check "database $(basename "$db"): snapshot intact ($(du -h "$WORK/databases/$rel" | cut -f1))"
        else fail "database $(basename "$db"): integrity check said: $r"; fi
      else fail "database $(basename "$db"): snapshot failed: $(head -c 200 "$ERRF")"; fi
    done < <(find "$d" -maxdepth 3 -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print0 2>/dev/null)
  done
  [ ${#list[@]} -gt 0 ] || { fail "none of this app's folders exist"; return; }
  # Everything else in those folders, as files. Live database files are left
  # out (their snapshots are under databases/); so are nested backups.
  local rels=(); for d in "${list[@]}"; do rels+=("${d#/}"); done
  if tar -C / -cf "$WORK/files.tar" \
      --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db-journal' \
      --exclude='*.sqlite' --exclude='*.sqlite3' --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' \
      --exclude='*/backups' --exclude='*/node_modules' "${EXCL[@]}" "${rels[@]}" 2>"$ERRF"; then
    check "files: $(tar -tf "$WORK/files.tar" | grep -vc '/$') from ${#list[@]} folder(s)"
  else fail "copying files failed: $(head -c 200 "$ERRF")"; fi
}

# ---- MySQL -------------------------------------------------------------------
backup_mysql() {
  local dbs=("${DBS[@]}") db
  if [ "${dbs[0]}" = __all__ ]; then
    mapfile -t dbs < <("$MYSQL" -N -e 'show databases' 2>/dev/null | grep -vE '^(information_schema|performance_schema|mysql|sys)$')
    [ ${#dbs[@]} -gt 0 ] || { fail "could not list the MySQL databases"; return; }
  fi
  mkdir -p "$WORK/mysql"
  for db in "${dbs[@]}"; do
    [[ $db =~ ^[A-Za-z0-9_]{1,64}$ ]] || { fail "skipped a database with an odd name"; continue; }
    if "$MYSQLDUMP" --single-transaction --quick --routines --triggers --events --databases "$db" 2>"$ERRF" > "$WORK/mysql/$db.sql"; then
      if tail -n 3 "$WORK/mysql/$db.sql" | grep -q 'Dump completed'; then
        gzip -9 "$WORK/mysql/$db.sql"
        check "MySQL $db: dump complete ($(du -h "$WORK/mysql/$db.sql.gz" | cut -f1) compressed)"
      else fail "MySQL $db: dump did not finish"; fi
    else fail "MySQL $db: $(head -c 200 "$ERRF")"; fi
  done
}

# ---- SQL Server ----------------------------------------------------------------
# BACKUP DATABASE as the login in $MSSQL_CNF (MSSQL_USER / MSSQL_PASSWORD, root
# 0600). The password goes to sqlcmd in SQLCMDPASSWORD, never on its command
# line. Each database is written WITH CHECKSUM (every page checked as it is
# read) and COPY_ONLY (it doesn't disturb any other backup chain), into SQL
# Server's own data folder (the only place it may write), then moved here.
backup_mssql() {
  local sq="$SQLCMD" u pw db f
  if [ -z "$sq" ]; then for f in /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd "$(command -v sqlcmd 2>/dev/null)"; do [ -n "$f" ] && [ -x "$f" ] && { sq="$f"; break; }; done; fi
  [ -n "$sq" ] || { fail "sqlcmd is not installed (sudo apt install mssql-tools18)"; return; }
  [ -f "$MSSQL_CNF" ] || { fail "no SQL Server login for backups yet: run sudo bash /opt/pulse/scripts/set-mssql-login.sh"; return; }
  [ "$(stat -c %a "$MSSQL_CNF")" = 600 ] || { fail "$MSSQL_CNF must be readable by root only (chmod 600)"; return; }
  u="$(sed -n 's/^MSSQL_USER=//p' "$MSSQL_CNF" | head -1)"; pw="$(sed -n 's/^MSSQL_PASSWORD=//p' "$MSSQL_CNF" | head -1)"
  [ -n "$u" ] && [ -n "$pw" ] || { fail "$MSSQL_CNF needs MSSQL_USER= and MSSQL_PASSWORD="; return; }
  local SQ=("$sq" -S localhost -U "$u" -C -b -h -1 -W)
  local dbs
  mapfile -t dbs < <(SQLCMDPASSWORD="$pw" "${SQ[@]}" -Q "SET NOCOUNT ON; SELECT name FROM sys.databases WHERE database_id > 4 AND state_desc = 'ONLINE'" 2>"$ERRF" | tr -d '\r' | sed '/^$/d')
  [ ${#dbs[@]} -gt 0 ] || { fail "could not list the SQL Server databases: $(head -c 200 "$ERRF")"; return; }
  mkdir -p "$WORK/mssql"
  for db in "${dbs[@]}"; do
    [[ $db =~ ^[A-Za-z0-9_]{1,64}$ ]] || { fail "skipped a database with an odd name"; continue; }
    f="$MSSQL_DIR/pulse-$db-$STAMP.bak"
    if SQLCMDPASSWORD="$pw" "${SQ[@]}" -Q "BACKUP DATABASE [$db] TO DISK = N'$f' WITH COPY_ONLY, CHECKSUM, INIT" >"$ERRF" 2>&1 && [ -s "$f" ]; then
      mv -f "$f" "$WORK/mssql/$db.bak" && gzip -9 "$WORK/mssql/$db.bak"
      check "SQL Server $db: backed up with page checksums ($(du -h "$WORK/mssql/$db.bak.gz" | cut -f1) compressed)"
    else rm -f "$f"; fail "SQL Server $db: $(grep -m1 -iE 'msg|error|denied|fail' "$ERRF" | head -c 200)"; fi
  done
}

# ---- IFAIMA: its own backup ----------------------------------------------------
backup_ifaima() {
  local before after f
  before="$(date +%s)"
  if timeout 600 "$SYSTEMCTL" start ifaima-backup.service 2>"$ERRF"; then
    check "ran IFAIMA's own backup (ifaima-backup.service)"
  else fail "ifaima-backup.service failed: $(head -c 200 "$ERRF")"; return; fi
  mkdir -p "$WORK/ifaima"
  for f in $(find "$P/var/backups/ifaima" -maxdepth 1 -type f -newermt "@$((before - 5))" 2>/dev/null); do
    cp -p "$f" "$WORK/ifaima/"
  done
  local n; n=$(find "$WORK/ifaima" -type f | wc -l)
  [ "$n" -gt 0 ] && check "IFAIMA wrote $n file(s); copies included" || fail "IFAIMA's backup wrote no new file in /var/backups/ifaima"
  for f in "$WORK"/ifaima/*.db.gz; do [ -f "$f" ] || continue
    if gzip -dc "$f" > "$WORK/ifaima.db" 2>/dev/null && [ "$("$SQLITE3" "$WORK/ifaima.db" 'PRAGMA integrity_check;' 2>&1 | head -1)" = ok ]; then
      check "IFAIMA database copy intact"; else fail "IFAIMA database copy failed its check"; fi
    rm -f "$WORK/ifaima.db"
  done
}

# ---- RondoQ: its own backup ----------------------------------------------------
# rondoq-backup.service runs RondoQ's backup.sh nightly: a pg_dump read back
# with pg_restore --list, the uploads archive, and (once /etc/rondoq-offsite.key
# exists) the encrypted copy to OneDrive, whose result it writes to
# /var/backups/rondoq/offsite-status. A failed off-site copy makes the service
# fail but leaves the local dump good, so the dump is judged on its own.
RQ_OFF=()
backup_rondoq() {
  local before f rc=0 st stline n st_was
  before="$(date +%s)"
  st="$RQ_BACKUPS/offsite-status"
  st_was="$(stat -c %y "$st" 2>/dev/null || echo none)"
  # The files that were there before; only new ones are this run's.
  local had; had="$(find "$RQ_BACKUPS" -maxdepth 1 -type f \( -name 'rondoq-*-nightly.dump' -o -name 'uploads-*.tgz' \) -printf '%f\n' 2>/dev/null)"
  timeout 1800 "$SYSTEMCTL" start rondoq-backup.service 2>"$ERRF" || rc=$?
  mkdir -p "$WORK/rondoq"
  for f in $(find "$RQ_BACKUPS" -maxdepth 1 -type f \( -name 'rondoq-*-nightly.dump' -o -name 'uploads-*.tgz' \) 2>/dev/null); do
    printf '%s\n' "$had" | grep -qxF "$(basename "$f")" && continue
    cp -p "$f" "$WORK/rondoq/"
  done
  n=$(find "$WORK/rondoq" -name '*.dump' | wc -l)
  if [ "$n" -eq 0 ]; then
    if [ "$rc" -ne 0 ]; then fail "rondoq-backup.service failed and wrote no new database dump: $(head -c 160 "$ERRF")"
    else fail "RondoQ's backup wrote no new database dump in $RQ_BACKUPS"; fi
    return
  fi
  check "ran RondoQ's own backup (rondoq-backup.service)"
  for f in "$WORK"/rondoq/*.dump; do
    if "$PG_RESTORE" --list "$f" >/dev/null 2>"$ERRF"; then check "RondoQ database dump reads back: $(basename "$f") ($(du -h "$f" | cut -f1))"
    else fail "RondoQ database dump did not read back: $(head -c 160 "$ERRF")"; fi
  done
  for f in "$WORK"/rondoq/uploads-*.tgz; do [ -f "$f" ] || continue
    gzip -t "$f" 2>/dev/null && check "RondoQ uploads archive opens ($(du -h "$f" | cut -f1))" || fail "RondoQ uploads archive did not open"
  done
  # RondoQ's own (encrypted) off-site copy, as RondoQ recorded it.
  if [ -f "$st" ] && [ "$(stat -c %y "$st")" != "$st_was" ]; then
    stline="$(head -1 "$st")"
    if [ "${stline%% *}" = ok ]; then
      for R in $(printf '%s' "$stline" | sed -n 's/.* to //p'); do RQ_OFF+=("{\"remote\":\"$(jesc "$R")\",\"ok\":true,\"by\":\"rondoq\",\"encrypted\":true}"); done
      check "RondoQ sent its encrypted off-site copy ($(printf '%s' "$stline" | sed -n 's/.* to //p'))"
    else
      RQ_OFF+=("{\"remote\":\"OneDrive\",\"ok\":false,\"by\":\"rondoq\",\"error\":\"RondoQ's encrypted off-site copy failed; see journalctl -u rondoq-backup\"}")
      echo "  ✗ RondoQ's encrypted off-site copy failed (the local backup is fine)"
    fi
  else
    echo "  · no off-site copy: RondoQ has no off-site key yet (sudo bash /opt/rondoq/bin/offsite-key.sh)"
  fi
}

# ---- PostgreSQL ----------------------------------------------------------------
# Every running cluster (pg_lsclusters), every database in it except the
# templates, "postgres" and those an app plan covers ($PG_SKIP), dumped as the
# postgres user with that cluster's own pg_dump, then read back.
backup_postgres() {
  local ver name port status rest dbs db f any=0 skipped=()
  [ -n "$(command -v "${PG_LSCLUSTERS%% *}" 2>/dev/null)" ] || [ -x "${PG_LSCLUSTERS%% *}" ] || { fail "pg_lsclusters is not available"; return; }
  mkdir -p "$WORK/postgresql"
  while read -r ver name port status rest; do
    [[ $ver =~ ^[0-9.]+$ ]] || continue
    [ "$status" = online ] || { echo "  · cluster $ver/$name is $status (skipped)"; continue; }
    mapfile -t dbs < <($AS_PG "$PG_BIN/$ver/bin/psql" -p "$port" -At -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1" 2>"$ERRF")
    for db in "${dbs[@]}"; do
      [[ $db =~ ^[A-Za-z0-9_]{1,63}$ ]] || { fail "skipped a database with an odd name"; continue; }
      if [[ " $PG_SKIP " == *" $db "* ]]; then skipped+=("$db"); continue; fi
      f="$WORK/postgresql/$ver-$name-$db.dump"
      if $AS_PG "$PG_BIN/$ver/bin/pg_dump" -p "$port" --format=custom --compress=6 "$db" 2>"$ERRF" > "$f" && [ -s "$f" ]; then
        if "$PG_RESTORE" --list "$f" >/dev/null 2>&1; then any=1; check "PostgreSQL $ver/$name $db: dump reads back ($(du -h "$f" | cut -f1))"
        else fail "PostgreSQL $db: the dump did not read back"; fi
      else fail "PostgreSQL $db: $(head -c 200 "$ERRF")"; fi
    done
    [ ${#dbs[@]} -gt 0 ] || check "cluster $ver/$name (port $port): no databases of its own"
  done < <($PG_LSCLUSTERS -h 2>/dev/null)
  if [ ${#skipped[@]} -gt 0 ]; then
    check "left to their app's own plan: ${skipped[*]} (RondoQ: encrypted off-site)"
    printf 'Databases backed up by their own app plan, not here: %s\n' "${skipped[*]}" > "$WORK/postgresql/README.txt"
  fi
  [ "$any" = 1 ] || [ ${#skipped[@]} -gt 0 ] || [ -n "$ERR" ] || check "no PostgreSQL databases to back up"
  [ -n "$(ls -A "$WORK/postgresql")" ] || printf 'No PostgreSQL databases needed a backup on %s.\n' "$STAMP" > "$WORK/postgresql/README.txt"
}

case "$METHOD" in files) backup_files ;; mysql) backup_mysql ;; mssql) backup_mssql ;; ifaima) backup_ifaima ;; rondoq) backup_rondoq ;; postgres) backup_postgres ;; esac

# ---- one archive, proven to open ----------------------------------------------
ARCH="$OUTDIR/$APP-$STAMP-${RID:0:6}.tar.gz"
BYTES=0; SHA=""
if [ -z "$ERR" ]; then
  (cd "$WORK" && tar -czf "$ARCH.part" .) 2>"$ERRF" \
    && gzip -t "$ARCH.part" && tar -tzf "$ARCH.part" >/dev/null \
    && mv -f "$ARCH.part" "$ARCH" && chmod 0600 "$ARCH" \
    && BYTES=$(stat -c %s "$ARCH") && SHA=$(sha256sum "$ARCH" | cut -c1-64) \
    && check "archive opens: $(basename "$ARCH") ($(du -h "$ARCH" | cut -f1))" \
    || fail "the archive could not be written or did not open"
fi
rm -f "$ARCH.part"

# ---- off-site ------------------------------------------------------------------
OFF=("${RQ_OFF[@]}")
if [ -z "$ERR" ] && [ "$OFFSITE" = 1 ] && [ "$OWN_OFFSITE" = 0 ]; then
  # The archive is root-only; rclone runs as deploy, so it gets a readable copy.
  T="$(mktemp /tmp/pulse-offsite-XXXXXX.tar.gz)"; cp "$ARCH" "$T"; chmod 0644 "$T"
  for R in $OFFSITE_REMOTES; do
    if timeout 900 $RCLONE copyto "$T" "$R$FOLDER/Backups/$(basename "$ARCH")" 2>"$ERRF"; then
      OFF+=("{\"remote\":\"$(jesc "$R")\",\"ok\":true}"); check "copied off-site to $R$FOLDER/Backups/"
    else
      OFF+=("{\"remote\":\"$(jesc "$R")\",\"ok\":false,\"error\":\"$(jesc "$(head -c 160 "$ERRF")")\"}"); echo "  ✗ off-site to $R failed (the local backup is fine)"
    fi
  done
  rm -f "$T"
fi

# ---- keep the newest $KEEP -------------------------------------------------------
ls -1t "$OUTDIR"/"$APP"-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f --
# Copies holding RondoQ's records never outlive RondoQ's own 30-day promise.
[ -n "$MAX_DAYS" ] && find "$OUTDIR" -maxdepth 1 -name "$APP-*.tar.gz" -mtime +"$MAX_DAYS" -delete 2>/dev/null

# ---- the record Pulse reads ---------------------------------------------------------
mkdir -p "$MAN_DIR"
C=""; for c in "${CHECKS[@]}"; do C+="${C:+,}\"$(jesc "$c")\""; done
O=""; for o in "${OFF[@]}"; do O+="${O:+,}$o"; done
LINE="{\"ts\":$(date +%s)000,\"app\":\"$APP\",\"id\":\"$RID\",\"method\":\"$METHOD\",\"ok\":$([ -z "$ERR" ] && echo true || echo false),\"file\":\"$( [ -z "$ERR" ] && jesc "$ARCH")\",\"bytes\":$BYTES,\"sha256\":\"$SHA\",\"seconds\":$(( $(date +%s) - START )),\"checks\":[$C],\"offsite\":[$O],\"error\":\"$(jesc "$ERR")\"}"
printf '%s\n' "$LINE" >> "$MAN_DIR/$APP.jsonl"
# The record file stays short: the last 200 runs.
tail -n 200 "$MAN_DIR/$APP.jsonl" > "$MAN_DIR/.$APP.tmp" && mv -f "$MAN_DIR/.$APP.tmp" "$MAN_DIR/$APP.jsonl"
if [ "$ROOT_UID" = 0 ]; then chown root:pulse "$MAN_DIR/$APP.jsonl" 2>/dev/null; fi
chmod 0640 "$MAN_DIR/$APP.jsonl"

if [ -z "$ERR" ]; then echo "Done in $(( $(date +%s) - START )) s."; exit 0; fi
echo "Backup failed: $ERR"; exit 1
