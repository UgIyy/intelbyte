// App registry for shield mode (Windows).
//
// Same two-part model as the Linux edition, adapted to Windows:
//   1) `intelbyte setup` discovers every CDP/BiDi-capable app (Chrome/Brave/Edge
//      by install path, Discord, and any Electron app found via a Start-Menu
//      shortcut whose target sits next to a resources\app.asar), pins each to a
//      stable debug port, and rewrites its Start-Menu / Desktop / taskbar
//      shortcuts so they always launch with the debug flag on.
//   2) The background shield watches all registered ports and injects the
//      masking agent the instant an app appears. Because a Windows shortcut only
//      covers launches that GO THROUGH it (unlike the Linux .desktop shadow),
//      the shield also detects an app started any other way — running but with
//      no debug port — and relaunches it in debug mode. That relaunch is the
//      real safety net; the shortcut rewrite just avoids the initial flicker.
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { load, save } from '../../core/config.js';
import { ps, psJson, psAsync, psq } from './ps.js';

const FIRST_PORT = 9300;

// %VAR% expansion against the current environment.
function expand(p) {
  return p.replace(/%([^%]+)%/g, (_, v) => process.env[v] || '');
}
function firstExisting(paths) {
  for (const p of paths) {
    const full = expand(p);
    if (full && existsSync(full)) return full;
  }
  return null;
}

// Known browsers / Discord by well-known install path. `image` is the running
// process name (for detect/kill); `chromium` is the profile key for the
// address-bar scrub. Anything not here can still be caught generically as an
// Electron app via its shortcut (see below).
const KNOWN = [
  {
    key: 'chrome', label: 'Google Chrome', protocol: 'cdp', kind: 'browser',
    image: 'chrome.exe', chromium: 'chrome',
    paths: [
      '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe',
    ],
  },
  {
    key: 'brave', label: 'Brave', protocol: 'cdp', kind: 'browser',
    image: 'brave.exe', chromium: 'brave',
    paths: [
      '%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%ProgramFiles(x86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%LocalAppData%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
  },
  {
    key: 'edge', label: 'Microsoft Edge', protocol: 'cdp', kind: 'browser',
    image: 'msedge.exe', chromium: 'edge',
    paths: [
      '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  },
  {
    key: 'firefox', label: 'Firefox', protocol: 'bidi', kind: 'firefox',
    image: 'firefox.exe', chromium: null,
    paths: [
      '%ProgramFiles%\\Mozilla Firefox\\firefox.exe',
      '%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe',
    ],
  },
  {
    key: 'discord', label: 'Discord', protocol: 'cdp', kind: 'discord',
    image: 'Discord.exe', chromium: null,
    // The Update.exe stub resolves the current app-x.y.z build for us.
    paths: ['%LocalAppData%\\Discord\\Update.exe'],
  },
];

const BROWSER_IMAGES = {
  'chrome.exe': 'chrome',
  'brave.exe': 'brave',
  'msedge.exe': 'edge',
  'firefox.exe': 'firefox',
};

// ---- shortcut enumeration (PowerShell / WScript.Shell) -------------------

// Resolve every .lnk under the Start Menu (user + machine), Desktop (user +
// public) and the taskbar-pinned folder to { Name, Lnk, Target, Arguments,
// WorkingDirectory }. These are both how we discover Electron apps generically
// AND the shortcuts we rewrite so launches come up in debug mode.
function enumerateShortcuts() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell
$dirs = @(
  [Environment]::GetFolderPath('Programs'),
  [Environment]::GetFolderPath('CommonPrograms'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
)
$out = @()
foreach ($d in $dirs) {
  if (-not (Test-Path $d)) { continue }
  Get-ChildItem -Path $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $s = $sh.CreateShortcut($_.FullName)
      if ($s.TargetPath) {
        $out += [PSCustomObject]@{
          Name    = $_.BaseName
          Lnk     = $_.FullName
          Target  = $s.TargetPath
          Arguments = $s.Arguments
          WorkingDirectory = $s.WorkingDirectory
        }
      }
    } catch {}
  }
}
$out | ConvertTo-Json -Depth 3
`;
  const parsed = psJson(script);
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Is `exe` an Electron app? (has a sibling resources\app.asar)
function isElectron(exe) {
  const dir = dirname(exe);
  return (
    existsSync(join(dir, 'resources', 'app.asar')) ||
    existsSync(join(dir, '..', 'resources', 'app.asar'))
  );
}

function slugify(s) {
  return String(s).toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---- discovery -----------------------------------------------------------

// Returns [{ id, label, protocol, kind, image, exe, launchArgs, chromium,
// shortcuts: [{lnk, origArgs}] }]. `exe`+`launchArgs` are how we (re)launch it
// with the debug flag; `shortcuts` are the .lnk files we rewrite.
export function discoverApps() {
  const shortcuts = enumerateShortcuts();
  const byId = new Map();

  const add = (rec) => {
    const prev = byId.get(rec.id);
    if (prev) {
      // merge shortcut lists, keep first-found launch info
      const seen = new Set(prev.shortcuts.map((s) => s.lnk.toLowerCase()));
      for (const s of rec.shortcuts) if (!seen.has(s.lnk.toLowerCase())) prev.shortcuts.push(s);
      return;
    }
    byId.set(rec.id, rec);
  };

  // 1) Known apps by install path (deterministic; works even with no shortcut).
  for (const k of KNOWN) {
    const exe = firstExisting(k.paths);
    if (!exe) continue;
    add({
      id: k.key,
      label: k.label,
      protocol: k.protocol,
      kind: k.kind,
      image: k.image,
      exe,
      launchArgs: k.kind === 'discord' ? ['--processStart', 'Discord.exe'] : [],
      chromium: k.chromium || null,
      shortcuts: [],
    });
  }

  // 2) Shortcuts: attach .lnk files to known apps, and pick up generic Electron.
  for (const sc of shortcuts) {
    const target = sc.Target;
    if (!target || !existsSync(target)) continue;
    const base = basename(target).toLowerCase();
    const args = sc.Arguments || '';

    let id = null;
    let rec = null;
    if (BROWSER_IMAGES[base]) {
      // A browser shortcut carrying a URL is a web-app shortcut, not the browser.
      if (/https?:\/\//i.test(args)) continue;
      id = BROWSER_IMAGES[base];
      if (!byId.has(id)) {
        const k = KNOWN.find((x) => x.key === id);
        rec = { id, label: k.label, protocol: k.protocol, kind: k.kind, image: k.image,
                exe: target, launchArgs: [], chromium: k.chromium || null, shortcuts: [] };
      }
    } else if (base === 'update.exe' && /discord\.exe/i.test(args)) {
      id = 'discord';
      if (!byId.has(id)) {
        rec = { id, label: 'Discord', protocol: 'cdp', kind: 'discord', image: 'Discord.exe',
                exe: target, launchArgs: ['--processStart', 'Discord.exe'], chromium: null, shortcuts: [] };
      }
    } else if (base.endsWith('.exe') && isElectron(target)) {
      id = slugify(basename(target));
      if (!id) continue;
      if (!byId.has(id)) {
        rec = { id, label: sc.Name || basename(target), protocol: 'cdp', kind: 'electron',
                image: basename(target), exe: target, launchArgs: [], chromium: null, shortcuts: [] };
      }
    } else {
      continue;
    }

    if (rec) add(rec);
    // record the shortcut with its CURRENT on-disk args (may already be wired
    // from a previous setup — setupApps recovers the pristine form below).
    const app = byId.get(id);
    if (app) {
      const low = sc.Lnk.toLowerCase();
      if (!app.shortcuts.some((s) => s.lnk.toLowerCase() === low)) {
        app.shortcuts.push({ lnk: sc.Lnk, args });
      }
    }
  }

  return [...byId.values()];
}

// Remove intelbyte's injected tokens from a shortcut argument string, so a
// re-setup (which reads back already-wired shortcuts) still recovers the
// pristine args to store for unsetup.
export function stripDebug(args) {
  return String(args || '')
    .replace(/--process-start-args\s+"[^"]*"/g, '') // Discord's wrapped flag
    .replace(/--remote-debugging-port=\d+/g, '')
    .replace(/--remote-allow-origins=\*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---- shortcut wiring (the debug flag lives in the shortcut's Arguments) ----

// The debug-flag string appended to a shortcut / launch for this app.
function debugArgs(app) {
  const flag = `--remote-debugging-port=${app.port}`;
  if (app.kind === 'discord') {
    // Discord's Update.exe forwards these to Discord.exe.
    return ['--process-start-args', `"${flag}"`];
  }
  if (app.kind === 'browser') {
    // Chrome/Edge/Brave 111+ refuse the DevTools WebSocket unless origins are
    // allowed; the normal profile is kept so logins survive.
    return [flag, '--remote-allow-origins=*'];
  }
  return [flag];
}

// Merge our debug args into a shortcut's existing arguments, idempotently.
export function mergeArgs(origArgs, app) {
  const flag = `--remote-debugging-port=${app.port}`;
  if (origArgs.includes(flag)) return origArgs; // already wired
  const extra = debugArgs(app).join(' ');
  return (origArgs.trim() + ' ' + extra).trim();
}

function setShortcutArgs(lnk, args) {
  ps(
    `$sh = New-Object -ComObject WScript.Shell; ` +
      `$s = $sh.CreateShortcut(${psq(lnk)}); ` +
      `$s.Arguments = ${psq(args)}; ` +
      `$s.Save()`
  );
}

// Rewrite all of an app's shortcuts to include the debug flag. `prevArgsByLnk`
// maps a shortcut path (lowercased) to the pristine args stored on a previous
// setup; we prefer that, else strip our tokens out of the current args, so the
// pristine form we save for unsetup is always the real original. Returns the
// list of shortcuts we touched.
export function wireShortcuts(app, prevArgsByLnk = new Map()) {
  const wired = [];
  for (const sc of app.shortcuts || []) {
    const key = sc.lnk.toLowerCase();
    const pristine = prevArgsByLnk.has(key) ? prevArgsByLnk.get(key) : stripDebug(sc.args);
    const newArgs = mergeArgs(pristine, app);
    try {
      setShortcutArgs(sc.lnk, newArgs);
      wired.push({ lnk: sc.lnk, origArgs: pristine });
    } catch {
      // shortcut locked / gone — skip; the watcher still protects via relaunch
    }
  }
  return wired;
}

// Restore an app's shortcuts to their pre-intelbyte arguments.
export function unwireShortcuts(registry) {
  const restored = [];
  for (const app of Object.values(registry || {})) {
    for (const sc of app.shortcuts || []) {
      try {
        setShortcutArgs(sc.lnk, sc.origArgs || '');
        restored.push(sc.lnk);
      } catch {
        // leave it
      }
    }
  }
  return restored;
}

// ---- registry ------------------------------------------------------------

export function setupApps() {
  const cfg = load();
  const prev = cfg.apps || {};
  const found = discoverApps();

  const usedPorts = new Set(Object.values(prev).map((a) => a.port));
  let nextPort = FIRST_PORT;
  const takePort = () => {
    while (usedPorts.has(nextPort)) nextPort++;
    usedPorts.add(nextPort);
    return nextPort;
  };

  // Pristine shortcut args captured on a prior setup, keyed by shortcut path.
  const prevArgsByLnk = new Map();
  for (const a of Object.values(prev)) {
    for (const s of a.shortcuts || []) prevArgsByLnk.set(s.lnk.toLowerCase(), s.origArgs || '');
  }

  const apps = {};
  for (const f of found) {
    const old = prev[f.id];
    const app = {
      label: f.label,
      protocol: f.protocol,
      kind: f.kind,
      image: f.image,
      exe: f.exe,
      launchArgs: f.launchArgs || [],
      chromium: f.chromium || null,
      port: old ? old.port : takePort(),
      shortcuts: [],
    };
    app.shortcuts = wireShortcuts({ ...f, port: app.port }, prevArgsByLnk);
    apps[f.id] = app;
  }
  const removedIds = Object.keys(prev).filter((id) => !apps[id]);
  cfg.apps = apps;
  save(cfg);
  return { apps, removedIds };
}

// ---- launching -----------------------------------------------------------

export function runAppArgv(id, extra = []) {
  const cfg = load();
  const app = (cfg.apps || {})[id];
  if (!app) return null;
  if (app.kind === 'discord') {
    return [app.exe, '--processStart', 'Discord.exe',
      '--process-start-args', `--remote-debugging-port=${app.port}`, ...extra];
  }
  const flags = [`--remote-debugging-port=${app.port}`];
  if (app.kind === 'browser') flags.push('--remote-allow-origins=*');
  return [app.exe, ...flags, ...extra];
}

export async function runApp(id, extra = []) {
  const cfg = load();
  const app = (cfg.apps || {})[id];
  if (!app) return false;
  // Chromium browser about to open ⇒ profile is unlocked, so purge protected
  // values from history/autofill now, before launch (native address bar).
  if (app.chromium) {
    try {
      const { scrubChromium, isBrowserRunning } = await import('./chromium.js');
      if (!isBrowserRunning(app.chromium)) await scrubChromium(cfg, app.chromium);
    } catch {
      // best-effort
    }
  }
  const argv = runAppArgv(id, extra);
  if (!argv) return false;
  try {
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---- process inspection --------------------------------------------------

// One CIM query answers both "is it running?" and "does it carry our port?".
// Returns 'stopped' | 'protected' | 'unprotected'.
export async function inspectAppState(app) {
  const script =
    `$p = @(Get-CimInstance Win32_Process -Filter "Name='${app.image}'" -ErrorAction SilentlyContinue); ` +
    `if ($p.Count -eq 0) { 'stopped' } ` +
    `elseif ($p | Where-Object { $_.CommandLine -like '*remote-debugging-port=${app.port}*' }) { 'protected' } ` +
    `else { 'unprotected' }`;
  try {
    const out = (await psAsync(script)).trim();
    if (out === 'protected' || out === 'unprotected' || out === 'stopped') return out;
    return 'stopped';
  } catch {
    return 'stopped';
  }
}

export async function runningUnprotected(id, app) {
  return (await inspectAppState(app)) === 'unprotected';
}

export async function killApp(app) {
  // /T also kills child processes (browsers/Electron spawn a tree).
  await psAsync(`Start-Process taskkill -ArgumentList '/F','/T','/IM','${app.image}' -WindowStyle Hidden -Wait`).catch(() => {});
}
