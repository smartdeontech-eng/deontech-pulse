#!/usr/bin/env bash
# DeonTech Pulse — hourly inventory scan.
#
# Runs as ROOT from pulse-scan.timer, because only root can see which process
# owns each listening port and read every user's authorized_keys and crontab.
#
# IT ONLY READS. It writes exactly one file, $OUT, and nothing else:
#   - no package installs, no service changes, no network calls
#   - key CONTENTS are never written, only fingerprints from ssh-keygen -lf
#   - secrets in crontab lines are redacted before they are written; a hash of
#     the raw line is kept so a changed job is still noticed
#
# $OUT lives in /var/lib/pulse-scan, a folder owned by ROOT (group pulse may
# read it). The temp file is created, owned and moved there by root alone, so
# the pulse user can never swap it for a symlink while root is chowning it.
#
# Output is tab-separated sections, parsed by core/discovery.js. Keeping the
# parsing in JavaScript (with tests) keeps this file short enough to audit.
set -uo pipefail
export LC_ALL=C

OUT="${1:-/var/lib/pulse-scan/inventory.txt}"
OUTDIR="$(dirname "$OUT")"
# Refuse to write anywhere the pulse user could tamper with.
[ "$(stat -c %U "$OUTDIR")" = root ] || { echo "$OUTDIR must be owned by root" >&2; exit 1; }
TMP="$(mktemp "${OUT}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

# Secrets in crontab lines: values after password/token-like keys, -pSECRET,
# user:pass@ in URLs, Bearer tokens, bot tokens, long URL path segments and
# query values, and any long token-looking run (JWTs included). Script paths
# are kept, so a changed job is still recognisable.
REDACT_PL=$(cat <<'PERL'
s/((?:pass(?:word)?|passwd|pwd|token|secret|api[_-]?key|apikey|auth|key)[=: ]+)[^\s;&|"']+/$1<redacted>/gi;
s/(^|\s)-p\S+/$1-p<redacted>/g;
s#(://[^/:@\s]+:)[^@\s]+@#$1<redacted>@#g;
s/(Bearer\s+)\S+/$1<redacted>/gi;
s#/bot\d+:[A-Za-z0-9_-]+#/bot<redacted>#g;
1 while s#(https?://[^\s"']*?/)([A-Za-z0-9_-]{16,})(?=[/?\#\s"']|$)#$1<redacted>#;
s#([?&][A-Za-z0-9_]+=)[^&\s"']{8,}#$1<redacted>#g;
s/(?<![A-Za-z0-9_\/.+=-])[A-Za-z0-9+=_.-]{32,}(?![A-Za-z0-9_\/+=-])/<redacted>/g;
PERL
)
redact() { perl -pe "$REDACT_PL"; }
linehash() { printf '%s' "$1" | sha256sum | cut -c1-12; }
unit_of() {   # pid -> systemd unit, from the process's cgroup
  local cg; cg="$(cat "/proc/$1/cgroup" 2>/dev/null | head -1)"
  local u; u="$(printf '%s' "$cg" | grep -oE '[^/]+\.service' | tail -1)"
  printf '%s' "${u:--}"
}

{
  printf '== meta\n'
  printf 'ts\t%s\n' "$(date +%s)"
  printf 'host\t%s\n' "$(hostname)"
  printf 'kernel\t%s\n' "$(uname -r)"
  printf 'uptime\t%s\n' "$(cut -d' ' -f1 /proc/uptime)"

  printf '== ports\n'
  # port <TAB> address <TAB> process <TAB> pid <TAB> unit <TAB> folder <TAB> pm2 name
  # The folder a process runs from and its PM2 name let Pulse name an app that
  # was started some other way than as its own systemd service (PM2, by hand).
  ss -tlnpH 2>/dev/null | while read -r _state _rq _sq local _peer procs; do
    port="${local##*:}"; addr="${local%:*}"
    proc="$(printf '%s' "$procs" | grep -oE '\("[^"]+"' | head -1 | tr -d '("')"
    pid="$(printf '%s' "$procs" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
    unit="-"; cwd="-"; pm2="-"
    if [ -n "$pid" ]; then
      unit="$(unit_of "$pid")"
      cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null | tr -d '\t\n')"; [ -n "$cwd" ] || cwd="-"
      # PM2 sets pm_id and name in the environment of each app it runs. Only
      # those two names are read; nothing else from the environment is kept.
      if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -q '^pm_id='; then
        pm2="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -m1 '^name=' | cut -d= -f2- | tr -cd 'A-Za-z0-9._-' | cut -c1-40)"
        [ -n "$pm2" ] || pm2="-"
      fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$port" "$addr" "${proc:--}" "${pid:--}" "$unit" "$cwd" "$pm2"
  done

  printf '== containers\n'
  # name <TAB> published ports (Docker only; nothing if Docker isn't installed)
  if command -v docker >/dev/null 2>&1; then
    timeout 10 docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | tr -cd 'A-Za-z0-9._:/>, \t\n[]-'
  fi

  printf '== users\n'
  # name <TAB> uid <TAB> home <TAB> shell <TAB> in-sudo-group
  sudoers=",$(getent group sudo | cut -d: -f4),$(getent group admin 2>/dev/null | cut -d: -f4),"
  getent passwd | awk -F: '$7 !~ /(nologin|false|sync)$/ {print $1"\t"$3"\t"$6"\t"$7}' | while IFS=$'\t' read -r n uid home sh; do
    s=no; case "$sudoers" in *",$n,"*) s=yes ;; esac; [ "$uid" = 0 ] && s=yes
    printf '%s\t%s\t%s\t%s\t%s\n' "$n" "$uid" "$home" "$sh" "$s"
  done

  printf '== keys\n'
  # user <TAB> file <TAB> fingerprint <TAB> type <TAB> comment <TAB> file-mtime
  # Every account (a key on a nologin account still allows tunnels), at every
  # location sshd actually reads (AuthorizedKeysFile, with %h/%u/%% expanded).
  akf="$(sshd -T 2>/dev/null | awk '/^authorizedkeysfile / {$1=""; print}')"
  [ -n "$akf" ] || akf=".ssh/authorized_keys .ssh/authorized_keys2"
  getent passwd | awk -F: '{print $1"\t"$6}' | while IFS=$'\t' read -r n home; do
    for pat in $akf; do
      [ "$pat" = none ] && continue
      f="${pat//%h/$home}"; f="${f//%u/$n}"; f="${f//%%/%}"
      case "$f" in /*) ;; *) f="$home/$f" ;; esac
      [ -f "$f" ] || continue
      # A symlinked key file is followed (sshd follows it too) and flagged.
      [ -L "$f" ] && f="$f -> $(readlink -f "$f")" 
      real="${f##* -> }"
      m="$(stat -c %Y "$real")"
      ssh-keygen -lf "$real" 2>/dev/null | while read -r _bits fp rest; do
        typ="$(printf '%s' "$rest" | grep -oE '\([A-Z0-9-]+\)$' | tr -d '()')"
        cmt="$(printf '%s' "$rest" | sed -E 's/ *\([A-Z0-9-]+\)$//')"
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$f" "$fp" "${typ:--}" "${cmt:--}" "$m"
      done
    done
  done

  printf '== cron\n'
  # owner <TAB> hash-of-raw-line <TAB> line (redacted)
  emit_cron() {   # owner, then lines on stdin
    while IFS= read -r line; do
      printf '%s\t%s\t%s\n' "$1" "$(linehash "$line")" "$(printf '%s' "$line" | redact)"
    done
  }
  for u in $(cut -d: -f1 /etc/passwd); do
    crontab -l -u "$u" 2>/dev/null | grep -vE '^\s*(#|$)' | emit_cron "$u"
  done
  for f in /etc/cron.d/*; do
    [ -f "$f" ] || continue
    grep -vE '^\s*(#|$|[A-Z_]+=)' "$f" | emit_cron "cron.d/$(basename "$f")"
  done

  printf '== backups\n'
  # dir <TAB> newest-epoch <TAB> newest-name <TAB> count <TAB> bytes <TAB> kind
  #   var    /var/backups/<name>   (nightly jobs, release copies) — files
  #   pulse  /var/backups/pulse/<app>  (Pulse's "Back up now") — files
  #   app    /opt/<app>/backups    (made by the app itself) — one entry each
  for d in /var/backups/*/; do
    [ -d "$d" ] || continue
    [ "${d%/}" = /var/backups/pulse ] && continue
    newest="$(find "$d" -maxdepth 2 -type f -printf '%T@\t%f\n' 2>/dev/null | sort -rn | head -1)"
    cnt="$(find "$d" -maxdepth 2 -type f 2>/dev/null | wc -l)"
    bytes="$(du -sb "$d" 2>/dev/null | cut -f1)"
    printf '%s\t%s\t%s\t%s\tvar\n' "${d%/}" "${newest:-0	-}" "$cnt" "${bytes:-0}"
  done
  for d in /var/backups/pulse/*/; do
    [ -d "$d" ] || continue
    newest="$(find "$d" -maxdepth 1 -type f -name '*.tar.gz' -printf '%T@\t%f\n' 2>/dev/null | sort -rn | head -1)"
    cnt="$(find "$d" -maxdepth 1 -type f -name '*.tar.gz' 2>/dev/null | wc -l)"
    bytes="$(du -sb "$d" 2>/dev/null | cut -f1)"
    printf '%s\t%s\t%s\t%s\tpulse\n' "${d%/}" "${newest:-0	-}" "$cnt" "${bytes:-0}"
  done
  for d in /opt/*/backups/ /opt/*/data/backups/; do
    [ -d "$d" ] || continue
    newest="$(find "$d" -mindepth 1 -maxdepth 1 -printf '%T@\t%f\n' 2>/dev/null | sort -rn | head -1)"
    cnt="$(find "$d" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)"
    bytes="$(du -sb "$d" 2>/dev/null | cut -f1)"
    printf '%s\t%s\t%s\t%s\tapp\n' "${d%/}" "${newest:-0	-}" "$cnt" "${bytes:-0}"
  done

  printf '== backupcheck\n'
  # The newest backup an app made itself: do its databases open, intact?
  # dir <TAB> newest <TAB> databases-found <TAB> result <TAB> detail
  # Read-only and immutable: nothing in the backup is touched.
  if command -v sqlite3 >/dev/null 2>&1; then
    for d in /opt/*/backups/ /opt/*/data/backups/; do
      [ -d "$d" ] || continue
      newest="$(find "$d" -mindepth 1 -maxdepth 1 -printf '%T@\t%p\n' 2>/dev/null | sort -rn | head -1 | cut -f2)"
      [ -n "$newest" ] && [ -d "$newest" ] || continue
      n=0; bad=""
      while IFS= read -r -d '' db; do
        n=$((n + 1))
        r="$(timeout 60 sqlite3 "file:$db?mode=ro&immutable=1" 'PRAGMA quick_check;' 2>&1 | head -1)"
        [ "$r" = ok ] || bad="$(basename "$db"): ${r:0:80}"
      done < <(find "$newest" -maxdepth 4 -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print0 2>/dev/null)
      if [ "$n" = 0 ]; then res=nodb; elif [ -n "$bad" ]; then res=bad; else res=ok; fi
      printf '%s\t%s\t%s\t%s\t%s\n' "${d%/}" "$(basename "$newest")" "$n" "$res" "${bad:--}"
    done
  fi

  printf '== offsite\n'
  # The nightly off-site job (rclone to OneDrive): which apps it covers, to
  # which remotes, when cron runs it and when it last ran. Its contents are not
  # copied here, only those facts.
  for f in /usr/local/bin/*offsite*.sh; do
    case "$f" in *.bak*) continue ;; esac
    [ -f "$f" ] || continue
    printf 'script\t%s\n' "$f"
    sed -n -E 's/^ACCTS=\(([^)]*)\).*/remotes\t\1/p' "$f" | head -1
    sed -n -E 's/^backup_app[[:space:]]+([^[:space:]]+)[[:space:]]+([A-Za-z0-9._-]+).*/app\t\1\t\2/p' "$f"
  done
  for f in /etc/cron.d/*; do
    [ -f "$f" ] || continue
    grep -hE '^[^#]*(offsite|backup-alert)' "$f" 2>/dev/null | awk '{printf "cron\t%s %s %s %s %s\t%s\n", $1, $2, $3, $4, $5, $7}'
  done
  last="$(journalctl -t CRON --since -3d -o short-unix --no-pager 2>/dev/null | grep -E 'CMD .*(offsite|backup-alert)' | tail -1 | cut -d' ' -f1 | cut -d. -f1)"
  [ -n "$last" ] && printf 'lastrun\t%s\n' "$last"

  printf '== datadirs\n'
  # path <TAB> bytes
  for d in /var/lib/* /var/opt/* /opt/*; do
    [ -d "$d" ] || continue
    printf '%s\t%s\n' "$d" "$(du -sb "$d" 2>/dev/null | cut -f1)"
  done
  printf '/opt/*.tar.gz\t%s\n' "$(find /opt -maxdepth 1 -name '*.tar.gz' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')"

  printf '== security\n'
  printf 'reboot_required\t%s\n' "$([ -f /var/run/reboot-required ] && echo yes || echo no)"
  printf 'upgradable\t%s\n' "$(apt list --upgradable 2>/dev/null | grep -c upgradable)"
  printf 'upgradable_security\t%s\n' "$(apt list --upgradable 2>/dev/null | grep -c -- '-security')"
  if command -v fail2ban-client >/dev/null 2>&1; then
    printf 'fail2ban_banned\t%s\n' "$(fail2ban-client status sshd 2>/dev/null | awk -F: '/Currently banned/ {gsub(/ /,"",$2); print $2}')"
  fi
  printf 'sshd_password_auth\t%s\n' "$(sshd -T 2>/dev/null | awk '/^passwordauthentication/ {print $2}')"
  printf 'sshd_root_login\t%s\n' "$(sshd -T 2>/dev/null | awk '/^permitrootlogin/ {print $2}')"
  for f in /etc/sudoers.d/*; do [ -f "$f" ] && printf 'sudoers_d\t%s\n' "$(basename "$f")"; done
  if command -v ufw >/dev/null 2>&1; then printf 'ufw\t%s\n' "$(ufw status 2>/dev/null | awk -F': ' '/^Status/ {print $2}')"; fi
} > "$TMP"

chown root:pulse "$TMP" 2>/dev/null || true
chmod 0640 "$TMP"
mv -f "$TMP" "$OUT"
trap - EXIT
