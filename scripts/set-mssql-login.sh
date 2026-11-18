#!/usr/bin/env bash
# Give Pulse a SQL Server login for backups. Run on the server, once:
#
#   sudo bash /opt/pulse/scripts/set-mssql-login.sh
#
# It asks for an ADMINISTRATOR login of SQL Server (usually "sa") at a hidden
# prompt, uses it ONCE to create a separate login, pulse_backup, that can only
# back databases up (db_backupoperator in each user database — no reading or
# changing data), and stores just that login in /etc/pulse-mssql.cnf (root
# only). The administrator password is not stored anywhere.
#
# Run it again after adding a new database to SQL Server, so pulse_backup can
# back that one up too. It keeps the existing pulse_backup password.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
CNF=/etc/pulse-mssql.cnf
SQ=""
for f in /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd "$(command -v sqlcmd 2>/dev/null || true)"; do [ -n "$f" ] && [ -x "$f" ] && { SQ="$f"; break; }; done
[ -n "$SQ" ] || { echo "sqlcmd is not installed. Install it first:  sudo apt install mssql-tools18 unixodbc-dev"; exit 1; }

read -r -p "SQL Server administrator login [sa]: " ADMIN; ADMIN="${ADMIN:-sa}"
read -r -s -p "Password for $ADMIN (hidden): " ADMINPW; echo
run() { SQLCMDPASSWORD="$ADMINPW" "$SQ" -S localhost -U "$ADMIN" -C -b -h -1 -W "$@"; }
run -Q "SET NOCOUNT ON; SELECT 1" >/dev/null || { echo "That login did not work."; exit 1; }

PW=""
[ -f "$CNF" ] && PW="$(sed -n 's/^MSSQL_PASSWORD=//p' "$CNF" | head -1)"
if [ -z "$PW" ]; then PW="P$(openssl rand -hex 16)!x"; fi   # letters, digits and a symbol: passes SQL Server's policy

# The new password goes in a root-only file read by sqlcmd -i, so it is never
# on a command line (where any user could see it with ps).
umask 077
SQLF="$(mktemp)"; trap 'rm -f "$SQLF"' EXIT
if run -Q "SET NOCOUNT ON; SELECT 1 FROM sys.server_principals WHERE name = 'pulse_backup'" | grep -q 1; then
  printf "ALTER LOGIN [pulse_backup] WITH PASSWORD = N'%s', CHECK_POLICY = ON;\n" "$PW" > "$SQLF"; run -i "$SQLF" >/dev/null
  echo "Login pulse_backup exists; password kept in step."
else
  printf "CREATE LOGIN [pulse_backup] WITH PASSWORD = N'%s', CHECK_POLICY = ON;\n" "$PW" > "$SQLF"; run -i "$SQLF" >/dev/null
  echo "Created login pulse_backup."
fi

mapfile -t DBS < <(run -Q "SET NOCOUNT ON; SELECT name FROM sys.databases WHERE database_id > 4 AND state_desc = 'ONLINE'" | tr -d '\r' | sed '/^$/d')
for db in "${DBS[@]}"; do
  [[ $db =~ ^[A-Za-z0-9_]{1,64}$ ]] || { echo "  skipped a database with an odd name"; continue; }
  run -d "$db" -Q "IF USER_ID('pulse_backup') IS NULL CREATE USER [pulse_backup] FOR LOGIN [pulse_backup]; ALTER ROLE [db_backupoperator] ADD MEMBER [pulse_backup];" >/dev/null
  echo "  ✓ $db: pulse_backup may back it up"
done

printf 'MSSQL_USER=pulse_backup\nMSSQL_PASSWORD=%s\n' "$PW" > "$CNF.tmp" && mv -f "$CNF.tmp" "$CNF"
chown root:root "$CNF"; chmod 600 "$CNF"
echo "Saved $CNF (root only). The $ADMIN password was not stored."
echo "Test it: Pulse → Backups → SQL Server → Back up now."
