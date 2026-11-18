// What an error IS: its kind, where in the code it happened, and a stable
// signature so the same fault seen 400 times is one group, not 400 rows.
//
// Works on the error "block" — the error line plus the stack trace lines that
// follow it — for .NET (Pledges) and Node (the core apps) alike.
'use strict';
const crypto = require('crypto');

// Frames that belong to the runtime or a library, not to the app's own code.
const NOT_APP_FRAME = /^(System\.|Microsoft\.|Npgsql\.|MySql\.|MySqlConnector\.|Pomelo\.|Newtonsoft\.|node:|internal\/|new Promise|process\.|Module\.|Object\.<anonymous>)|node_modules|<anonymous>|\(native\)/;

// .NET:  "   at Pledge.Controllers.PledgeController.Submit(PledgeDto dto) in /src/Controllers/PledgeController.cs:line 42"
const DOTNET_FRAME = /^\s*at\s+([^\s(]+)(\([^)]*\))?(?:\s+in\s+(.+?):line\s+(\d+))?\s*$/;
// Node:  "    at submit (/opt/aotc-track/routes/pledges.js:120:15)"  or  "    at /opt/x/y.js:3:9"
const NODE_FRAME = /^\s*at\s+(?:(?:async\s+)?([^\s(]+)\s+\()?([^()\s]+?):(\d+):\d+\)?\s*$/;

const TYPE_RE = /\b((?:[A-Za-z_][\w]*\.)*(?:[A-Za-z_]\w*)?(?:Exception|Error))\b(?:\s*\([^)]*\))?(?::\s*(.*))?/;

function parseFrame(line) {
  let m = line.match(DOTNET_FRAME);
  if (m && m[1].includes('.')) {
    const parts = m[1].split('.');
    const short = parts.slice(-2).join('.');
    return { fn: m[1], short, file: m[3] || null, line: m[4] ? Number(m[4]) : null, raw: line.trim() };
  }
  m = line.match(NODE_FRAME);
  if (m) {
    const file = m[2];
    const base = file.split('/').pop();
    return { fn: m[1] || null, short: m[1] ? `${m[1]} (${base}:${m[3]})` : `${base}:${m[3]}`, file, line: Number(m[3]), raw: line.trim() };
  }
  return null;
}

function isAppFrame(f) { return !!f && !NOT_APP_FRAME.test(f.fn || '') && !NOT_APP_FRAME.test(f.file || ''); }

// Numbers, ids, quoted values and the like vary between two instances of the
// same fault; they must not split a group.
function normalize(s) {
  return String(s || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "'…'")
    .replace(/\b\d+(\.\d+)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Strip what a logger puts in front: "fail: ", timestamps, "[ERR]", "Error:" levels.
function stripPrefix(s) {
  return String(s || '')
    .replace(/^\s*\d{4}-\d{2}-\d{2}[T ][\d:.,]+Z?\s*/, '')
    .replace(/^\s*\[?(fail|crit|error|err|fatal|warn)\]?:?\s*/i, '')
    .trim();
}

function analyse(app, lines) {
  const text = lines.join('\n');
  let type = null, message = null;
  for (const l of lines) {
    if (DOTNET_FRAME.test(l) || NODE_FRAME.test(l)) continue;
    // "Error: …" / "TypeError: …" at the start of a line IS the type (Node); otherwise strip logger prefixes first.
    const m = (/^\s*(?:[A-Za-z_][\w.]*)?(Error|Exception)\b/.test(l) ? l.trim() : stripPrefix(l)).match(TYPE_RE);
    if (m) { type = m[1]; message = (m[2] || '').trim() || null; break; }
  }
  const frames = lines.map(parseFrame).filter(Boolean);
  const frame = frames.find(isAppFrame) || frames[0] || null;
  const first = stripPrefix(lines.find((l) => l.trim()) || '');
  const shortType = type ? type.split('.').pop() : null;

  let key;
  if (type && frame) key = `${type}|${frame.fn || ''}|${frame.file || ''}`;
  else if (type) key = `${type}|${normalize(message || first)}`;
  else key = normalize(first);
  const sig = crypto.createHash('sha1').update(`${app}|${key}`).digest('hex').slice(0, 16);

  const where = frame && isAppFrame(frame) ? frame.short : null;
  // A bare "Error" says nothing; its message is the useful part.
  const title = shortType === 'Error' && message
    ? `${message.slice(0, 70)}${where ? ` — ${where}` : ''}`
    : shortType
      ? `${shortType}${where ? ` in ${where}` : ''}`
      : first.slice(0, 90) || 'Error';
  return { sig, title, type, message: (message || first).slice(0, 300), frame: frame ? frame.raw.slice(0, 300) : null, frameIsApp: isAppFrame(frame), text };
}

// Plain-English first aid. First match wins; order is most specific first.
const HINTS = [
  { re: /ENOSPC|No space left on device|disk (is )?full/i, title: 'The disk is full', cause: 'The app could not write a file or database page because the disk has no space left.',
    steps: ['Check free space: df -h /', 'Clear old logs or release tarballs (Pulse → To tidy up lists them)', 'Then restart the app'] },
  { re: /out of memory|OutOfMemory|heap out of memory|Cannot allocate memory|OOM/i, title: 'The app ran out of memory', cause: 'The process asked for more memory than it could get; usually a leak, or one request loading far too much data.',
    steps: ['See memory on Pulse → Server, and whether swap was full at the time', 'Restart the app to recover now', 'If it repeats, look for the request that came just before (shown below)'] },
  { re: /ECONNREFUSED|Connection refused|actively refused|Unable to connect to any of the specified MySQL hosts|could not connect to server/i, title: 'Something it depends on is not answering', cause: 'The app tried to reach another service (a database, another app, an API) and nothing was listening.',
    steps: ['Pulse → Apps: is the database or service it uses down?', 'sudo systemctl status mysql   (or mssql-server, postgresql)', 'Start it, then check the error stops'] },
  { re: /Login failed for user|Access denied for user|password authentication failed|authentication failed/i, title: 'Database login rejected', cause: 'The database refused the app\'s username or password: a changed password, a missing user, or the wrong connection string.',
    steps: ['Compare the connection string in the app\'s config with the database user', 'Check nobody changed the database password recently (Pulse → Access)'] },
  { re: /Timeout expired|timed out|TimeoutException|TaskCanceledException|ETIMEDOUT|ESOCKETTIMEDOUT|deadline exceeded/i, title: 'Something took too long', cause: 'A database query or a call to another service did not answer in time. Often a slow query, a lock, or the server being overloaded at that moment.',
    steps: ['Pulse → Server: was CPU or disk busy at that time?', 'If it is always the same request, that query needs an index or a smaller result', 'Check the other service is healthy'] },
  { re: /database is locked|SQLITE_BUSY|deadlock|Lock wait timeout/i, title: 'Two writes collided in the database', cause: 'Two things tried to change the same data at once and one gave up.',
    steps: ['Usually harmless if rare: the user can retry', 'If frequent, two processes may be writing the same database (e.g. both blue and green lines running)'] },
  { re: /EACCES|Permission denied|UnauthorizedAccessException|Access to the path .* is denied|EPERM/i, title: 'Permission denied', cause: 'The app\'s user is not allowed to read or write a file or folder it needs.',
    steps: ['The error names the path; check its owner: ls -l <path>', 'Give the app\'s service user access (sudo chown / chmod) — not root-only'] },
  { re: /ENOENT|FileNotFoundException|DirectoryNotFoundException|no such file or directory|Could not find file/i, title: 'A file or folder is missing', cause: 'The app expected a file that is not there: deleted, not deployed, or a wrong path in config.',
    steps: ['The error names the path; check it exists on the server', 'If it came with a release, the release may have missed it'] },
  { re: /EADDRINUSE|address already in use/i, title: 'Its port is already taken', cause: 'The app could not start because another process is listening on its port (often an old copy still running).',
    steps: ['See who holds it: sudo ss -ltnp | grep :<port>', 'Stop the old process, then start the app'] },
  { re: /NullReferenceException|Cannot read propert(y|ies) of (undefined|null)|undefined is not|is not a function|is null/i, title: 'A bug in the code: something was missing', cause: 'The code used a value that was not there (null/undefined). Usually a form field left empty, a record that was deleted, or data in a shape the code did not expect.',
    steps: ['The highlighted line in the stack trace is where it happened', 'The request below shows which page triggered it — try the same thing yourself', 'Fix in the code: check for the missing value before using it'] },
  { re: /DbUpdateException|UNIQUE constraint|duplicate key|Duplicate entry|FOREIGN KEY constraint|violates .* constraint|IntegrityError/i, title: 'The database refused the change', cause: 'Saving broke a database rule: a duplicate of something that must be unique, or a link to a record that does not exist.',
    steps: ['The inner exception names the rule and table', 'Often a double-submit (user clicked twice) — harmless', 'If not, the code needs to check before saving'] },
  { re: /Unknown column|Invalid column name|no such column|no such table|Invalid object name|relation .* does not exist/i, title: 'Code and database do not match', cause: 'The code expects a table or column the database does not have — usually a release whose database migration did not run.',
    steps: ['Check the last release ran its migrations', 'Compare the column named in the error with the database'] },
  { re: /certificate|SSL|TLS|self.signed|UNABLE_TO_VERIFY/i, title: 'A secure connection failed', cause: 'A certificate was expired, untrusted or for the wrong name when the app connected to something over HTTPS/TLS.',
    steps: ['Pulse → Apps shows certificate expiry for the sites on this server', 'If it is an outside service, check its certificate and the server clock (timedatectl)'] },
  { re: /FormatException|InvalidCastException|JsonException|SyntaxError: Unexpected token|Invalid date|NaN/i, title: 'Data in an unexpected format', cause: 'The app could not read a value: text where a number was expected, a broken date, or malformed JSON.',
    steps: ['The request below shows what was being sent', 'Fix the input check in the code, or the bad record in the database'] },
  { re: /InvalidOperationException|ObjectDisposedException/i, title: 'The code did something at the wrong moment', cause: 'An operation was attempted on something not ready for it (already closed, already used, or in the wrong state).',
    steps: ['The highlighted stack line is where; the message says what state it was in', 'Usually needs a code fix'] },
];
const GENERIC = { title: 'An error the app logged', cause: 'Read the error and the lines just before it — the first line that is not "at …" usually says what went wrong, and the highlighted frame says where.',
  steps: ['Look at the request that failed at the same moment (below)', 'Use the server command below to see the full log around it'] };

function hintFor(text) {
  const h = HINTS.find((x) => x.re.test(text)) || GENERIC;
  return { title: h.title, cause: h.cause, steps: h.steps };
}

// A command that shows the raw log around one occurrence, as the server sees it.
function journalCommand(unit, ts, beforeS = 60, afterS = 30) {
  const f = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  return `sudo journalctl -u ${unit} --since "${f(ts - beforeS * 1000)} UTC" --until "${f(ts + afterS * 1000)} UTC" --no-pager`;
}

module.exports = { analyse, parseFrame, isAppFrame, normalize, hintFor, journalCommand, HINTS };
