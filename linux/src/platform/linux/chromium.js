// Chromium profile scrubbing (Linux paths).
//
// The omnibox (address bar), its autocomplete dropdown, and the autofill popup
// are native browser UI — no CDP/BiDi/extension can rewrite them (unlike page
// content). So instead of masking them, we remove the leak at the SOURCE: the
// protected email/phone is deleted from the profile's on-disk stores that feed
// those suggestions — browsing history, typed URLs, search terms, and autofill.
// Nothing to suggest ⇒ nothing leaks in the bar, and no trace is left behind.
//
// These stores are SQLite files that the browser keeps EXCLUSIVELY locked while
// it runs, so scrubbing only works when the browser is closed. intelbyte does it
// from the wired launcher, right before it (re)launches the browser — the one
// moment the profile is guaranteed unlocked. If the browser is already running,
// the caller tells the user to close and reopen it.
import initSqlJs from 'sql.js';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { phoneDigits } from '../../core/config.js';

const HOME = homedir();
const require = createRequire(import.meta.url);
// Resolve sql.js's dist dir from the actual installed package (its main entry
// is dist/sql-wasm.js), so it works no matter what the repo folder is named or
// where it lives. locateFile then finds sql-wasm.wasm next to it.
const SQL_DIST = dirname(require.resolve('sql.js'));

// Per-browser Chromium *user-data* roots (native + flatpak). Each holds one or
// more profile dirs (Default, "Profile 1", …). Firefox is NOT here — it isn't
// Chromium and its address bar is handled by firefox.js.
const ROOTS = {
  chrome: {
    roots: [
      join(HOME, '.config/google-chrome'),
      join(HOME, '.var/app/com.google.Chrome/config/google-chrome'),
    ],
    // truncated comm names (Linux caps at 15 chars) included
    procs: ['chrome', 'google-chrome', 'google-chrome-s'],
  },
  chromium: {
    roots: [
      join(HOME, '.config/chromium'),
      join(HOME, '.var/app/org.chromium.Chromium/config/chromium'),
    ],
    procs: ['chromium', 'chromium-browse'],
  },
  brave: {
    roots: [
      join(HOME, '.config/BraveSoftware/Brave-Browser'),
      join(HOME, '.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser'),
    ],
    procs: ['brave', 'brave-browser'],
  },
  edge: {
    roots: [
      join(HOME, '.config/microsoft-edge'),
      join(HOME, '.var/app/com.microsoft.Edge/config/microsoft-edge'),
    ],
    procs: ['msedge', 'microsoft-edge'],
  },
};

// SQLite files inside a profile that can hold personal strings. Scrubbed
// generically (every text column of every table), so schema changes across
// Chrome versions don't matter.
const DB_FILES = ['History', 'Web Data', 'Login Data', 'Shortcuts', 'Top Sites'];

let SQL = null;
async function sql() {
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: (f) => join(SQL_DIST, f) });
  }
  return SQL;
}

// Which browser keys, if any, are actually installed (have a user-data root).
export function installedChromiumBrowsers() {
  const out = [];
  for (const [name, spec] of Object.entries(ROOTS)) {
    if (spec.roots.some((r) => existsSync(r))) out.push(name);
  }
  return out;
}

// Is the browser currently running? We must never write its SQLite files while
// it is (that corrupts the live DB), and a running browser holds the profile
// anyway. Detected by process name — reliable and matches how we detect other
// running apps. (SingletonLock files can go stale after a crash, so we don't
// rely on them.)
export function isBrowserRunning(name) {
  const procs = (ROOTS[name] && ROOTS[name].procs) || [];
  for (const p of procs) {
    try {
      execFileSync('pgrep', ['-x', p], { stdio: 'ignore' });
      return true;
    } catch {
      // pgrep exits non-zero when no match — keep checking
    }
  }
  return false;
}

// Every profile dir (Default, Profile N, …) across a browser's roots. A profile
// is any child dir that contains at least one of the target DBs.
function profileDirs(name) {
  const dirs = [];
  for (const root of (ROOTS[name] && ROOTS[name].roots) || []) {
    if (!existsSync(root)) continue;
    let kids;
    try {
      kids = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const k of kids) {
      if (!k.isDirectory()) continue;
      const p = join(root, k.name);
      if (DB_FILES.some((f) => existsSync(join(p, f)))) dirs.push(p);
    }
  }
  return dirs;
}

// The literal strings to purge: each protected email as-is, and each phone in
// several on-disk shapes (raw entry + digits-only + last-10 significant digits),
// so however the browser stored it, it's caught.
export function scrubTerms(cfg) {
  const terms = new Set();
  for (const e of cfg.emails || []) if (e.real) terms.add(e.real);
  for (const p of cfg.phones || []) {
    if (!p.real) continue;
    terms.add(p.real);
    const d = phoneDigits(p.real);
    if (d.length >= 7) {
      terms.add(d);
      if (d.length >= 10) terms.add(d.slice(-10));
    }
  }
  return [...terms].filter((t) => t.length >= 5); // avoid over-broad matches
}

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

// Delete every row containing any term, from every text column of every table.
// Returns rows removed. Best-effort per statement (virtual/FTS tables may throw).
function scrubDb(db, terms) {
  let removed = 0;
  const tables = [];
  const res = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  if (res[0]) for (const [t] of res[0].values) tables.push(t);

  for (const table of tables) {
    if (table.startsWith('sqlite_')) continue;
    let cols;
    try {
      cols = db.exec(`PRAGMA table_info(${q(table)})`);
    } catch {
      continue;
    }
    if (!cols[0]) continue;
    // type column can be empty (SQLite is dynamically typed) — treat those as text too.
    const textCols = cols[0].values
      .filter(([, , type]) => !type || /CHAR|CLOB|TEXT|BLOB/i.test(type))
      .map(([, cname]) => cname);
    for (const col of textCols) {
      for (const term of terms) {
        try {
          const stmt = db.prepare(
            `DELETE FROM ${q(table)} WHERE CAST(${q(col)} AS TEXT) LIKE :t`
          );
          stmt.run({ ':t': `%${term}%` });
          stmt.free();
          removed += db.getRowsModified(); // rows deleted by the statement just run
        } catch {
          // table/column can't be filtered this way — skip it
        }
      }
    }
  }
  return removed;
}

// Scrub every profile of every installed Chromium browser (or just `only`).
// Skips (and reports) any DB whose browser is still running (locked).
// Returns { scrubbed: [{browser, profile, db, removed}], locked: [browserKey] }.
export async function scrubChromium(cfg, only = null) {
  const SQLmod = await sql();
  const terms = scrubTerms(cfg);
  const scrubbed = [];
  const locked = new Set();
  if (!terms.length) return { scrubbed, locked: [] };

  const names = only ? [only] : installedChromiumBrowsers();
  for (const name of names) {
    // Never touch a running browser's DBs — writing under it corrupts them.
    if (isBrowserRunning(name)) {
      locked.add(name);
      continue;
    }
    for (const profile of profileDirs(name)) {
      for (const file of DB_FILES) {
        const path = join(profile, file);
        if (!existsSync(path)) continue;
        let bytes;
        try {
          bytes = readFileSync(path);
        } catch {
          continue;
        }
        let db;
        try {
          db = new SQLmod.Database(bytes);
        } catch {
          continue;
        }
        let removed = 0;
        try {
          removed = scrubDb(db, terms);
          if (removed > 0) {
            db.run('VACUUM'); // reclaim pages so deleted text isn't recoverable
            const out = Buffer.from(db.export());
            writeFileSync(path, out);
          }
        } catch {
          // leave this DB untouched on any failure
        } finally {
          db.close();
        }
        if (removed > 0) {
          scrubbed.push({ browser: name, profile: profileName(profile), db: file, removed });
        }
      }
    }
  }
  return { scrubbed, locked: [...locked] };
}

function profileName(dir) {
  const parts = dir.split('/');
  return parts[parts.length - 1];
}

// Profile count per browser — for status reporting (doctor).
export function chromiumProfileCount(name) {
  return profileDirs(name).length;
}
