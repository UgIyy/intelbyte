// Background-app machinery for Windows: run the shield hidden, keep it alive
// across the session, auto-start it at login, and expose start/stop/status/pause
// controls. This is what makes the Windows edition "run in the back" instead of
// living in a foreground terminal like the Linux edition.
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  appendFileSync,
} from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { load, configDir } from './core/config.js';
import platform from './platform/index.js';
import { runShield } from './shield.js';
import { ps, psq } from './platform/windows/ps.js';
import { c, ok, info, warn, err, title, line } from './core/ui.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN_JS = join(REPO_ROOT, 'bin', 'intelbyte.js');

const DIR = configDir();
const PID_FILE = join(DIR, 'shield.pid');
const STATUS_FILE = join(DIR, 'status.json');
const LOG_FILE = join(DIR, 'shield.log');
const PAUSE_FLAG = join(DIR, 'paused.flag');
const VBS_FILE = join(DIR, 'run-hidden.vbs');

const STARTUP_DIR = join(
  process.env.APPDATA || '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
const STARTUP_LNK = join(STARTUP_DIR, 'intelbyte.lnk');

function ensureDir() {
  mkdirSync(DIR, { recursive: true });
}

function logLine(s) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`);
  } catch {
    // logging is best-effort
  }
}

// ---- pid / liveness ------------------------------------------------------

function readPid() {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 just tests existence (works on Windows)
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // exists but not ours
  }
}

export function isRunning() {
  return alive(readPid());
}

// ---- status --------------------------------------------------------------

function writeStatus(obj) {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2));
  } catch {
    // best-effort
  }
}

function readStatus() {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function isPaused() {
  return existsSync(PAUSE_FLAG);
}

// ---- the hidden worker (`intelbyte shield-bg`) ---------------------------

// Runs in the hidden background process. Keeps the shield alive forever, writes
// a heartbeat to status.json, and honours the pause flag.
export async function runBackgroundWorker() {
  ensureDir();
  // Refuse to start a second worker (e.g. login auto-start + a manual start) —
  // two would fight over the same ports and PID file.
  const existing = readPid();
  if (existing && existing !== process.pid && alive(existing)) {
    logLine(`shield-bg: another worker (pid ${existing}) is already running — exiting`);
    process.exit(0);
  }
  writeFileSync(PID_FILE, String(process.pid));
  logLine(`shield-bg started (pid ${process.pid})`);

  const cfg = load();
  let last = { type: 'starting' };
  let lastWrite = 0;
  const snapshot = (extra) => {
    const now = Date.now();
    writeStatus({
      pid: process.pid,
      running: true,
      paused: isPaused(),
      updated: new Date().toISOString(),
      apps: Object.keys(cfg.apps || {}).length,
      ...last,
      ...extra,
    });
    lastWrite = now;
  };

  const handle = await runShield(platform, cfg, {
    quiet: true,
    isPaused,
    onEvent: (ev) => {
      if (['connected', 'closed', 'relaunch', 'gaveup', 'stopped'].includes(ev.type)) {
        logLine(`${ev.type}${ev.label ? ' ' + ev.label : ''}`);
        last = ev;
        snapshot();
      } else if (ev.type === 'tick' || ev.type === 'active' || ev.type === 'paused') {
        // heartbeat — throttle to ~once every 3s
        if (Date.now() - lastWrite > 3000) {
          if (ev.connected) last = { ...last, connected: ev.connected };
          snapshot({ heartbeat: ev.type });
        }
      }
    },
  });

  if (!handle) {
    // nothing to do (no entries / no wired apps) — record it and idle so the
    // process doesn't flap; `intelbyte status` will show why.
    writeStatus({
      pid: process.pid,
      running: true,
      idle: true,
      reason: 'nothing to protect / no wired apps — run setup',
      updated: new Date().toISOString(),
    });
    logLine('idle: nothing to protect or no wired apps');
  } else {
    snapshot({ type: 'active' });
  }

  const shutdown = () => {
    logLine('shield-bg stopping');
    try {
      if (handle) handle.stop();
    } catch {
      // ignore
    }
    try {
      unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
    writeStatus({ running: false, updated: new Date().toISOString() });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {}); // run forever
}

// ---- start / stop --------------------------------------------------------

// Launch the hidden worker (no console window). windowsHide + detached means no
// flash and no dependency on this terminal staying open.
export function startDetached() {
  ensureDir();
  const child = spawn(process.execPath, [BIN_JS, 'shield-bg'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

export function stop() {
  const pid = readPid();
  if (!alive(pid)) {
    try {
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
    return false;
  }
  try {
    ps(`Start-Process taskkill -ArgumentList '/PID','${pid}','/F','/T' -WindowStyle Hidden -Wait`);
  } catch {
    try {
      process.kill(pid);
    } catch {
      // ignore
    }
  }
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
  return true;
}

// ---- auto-start at login (Startup shortcut → hidden VBS) ------------------

// A tiny VBS that launches node hidden (window style 0), so login start-up
// never flashes a console window.
function writeVbs() {
  const cmd = `"${process.execPath}" "${BIN_JS}" shield-bg`;
  const vbsCmd = cmd.replace(/"/g, '""'); // VBS escapes a quote by doubling it
  const vbs =
    'Set sh = CreateObject("WScript.Shell")\r\n' +
    `sh.Run "${vbsCmd}", 0, False\r\n`;
  writeFileSync(VBS_FILE, vbs);
  return VBS_FILE;
}

function createStartupShortcut(vbsPath) {
  mkdirSync(STARTUP_DIR, { recursive: true });
  const wscript = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  ps(
    `$sh = New-Object -ComObject WScript.Shell; ` +
      `$s = $sh.CreateShortcut(${psq(STARTUP_LNK)}); ` +
      `$s.TargetPath = ${psq(wscript)}; ` +
      `$s.Arguments = ${psq('"' + vbsPath + '"')}; ` +
      `$s.WorkingDirectory = ${psq(REPO_ROOT)}; ` +
      `$s.Description = 'intelbyte screen-privacy shield'; ` +
      `$s.Save()`
  );
}

export function installAutostart() {
  ensureDir();
  const vbs = writeVbs();
  createStartupShortcut(vbs);
  return STARTUP_LNK;
}

export function uninstallAutostart() {
  let removed = false;
  try {
    if (existsSync(STARTUP_LNK)) {
      unlinkSync(STARTUP_LNK);
      removed = true;
    }
  } catch {
    // ignore
  }
  return removed;
}

export function isAutostartInstalled() {
  return existsSync(STARTUP_LNK);
}

// ---- CLI command surface -------------------------------------------------

export function cmdInstall() {
  title('intelbyte • install background shield');
  const lnk = installAutostart();
  ok('Auto-start at login installed: ' + c.gray(lnk));
  if (isRunning()) {
    info('Background shield already running.');
  } else {
    startDetached();
    ok('Background shield started (hidden). It masks wired apps as you open them.');
  }
  line('');
  info('Manage it: ' + c.cyan('intelbyte status') + c.gray(' / ') + c.cyan('intelbyte stop') + c.gray(' / ') + c.cyan('intelbyte restart'));
  info('Tray icon (optional): ' + c.cyan('intelbyte tray'));
}

export function cmdUninstall() {
  title('intelbyte • uninstall background shield');
  const wasRunning = stop();
  const removed = uninstallAutostart();
  if (removed) ok('Removed auto-start entry.');
  else info('No auto-start entry was present.');
  if (wasRunning) ok('Stopped the running background shield.');
  info('Your protected entries and app wiring are untouched. Remove wiring with ' + c.cyan('intelbyte unsetup') + '.');
}

export function cmdStart() {
  if (isRunning()) {
    info('Background shield is already running (pid ' + readPid() + ').');
    return;
  }
  ensureDir();
  const pid = startDetached();
  ok('Background shield started (hidden), pid ' + pid + '.');
}

export function cmdStop() {
  if (stop()) ok('Background shield stopped.');
  else info('Background shield was not running.');
}

export function cmdRestart() {
  stop();
  const pid = startDetached();
  ok('Background shield restarted, pid ' + pid + '.');
}

export function cmdPause() {
  ensureDir();
  writeFileSync(PAUSE_FLAG, new Date().toISOString());
  ok('Masking paused. The shield keeps running but stops touching apps.');
  info('Resume with ' + c.cyan('intelbyte resume') + '.');
}

export function cmdResume() {
  try {
    if (existsSync(PAUSE_FLAG)) unlinkSync(PAUSE_FLAG);
  } catch {
    // ignore
  }
  ok('Masking resumed.');
}

export function cmdStatus() {
  title('intelbyte • background shield status');
  const running = isRunning();
  const pid = readPid();
  if (running) ok(`Running (pid ${pid})` + (isPaused() ? c.yellow('  · PAUSED') : ''));
  else warn('Not running. Start it with ' + c.cyan('intelbyte start') + ' or ' + c.cyan('intelbyte install') + '.');

  ok('Auto-start at login: ' + (isAutostartInstalled() ? c.green('installed') : c.gray('not installed')));

  const st = readStatus();
  if (st) {
    if (st.idle) warn('Shield idle: ' + (st.reason || 'nothing to protect'));
    const conn = (st.connected || []).length;
    line(c.gray('  wired apps: ') + (st.apps ?? '?') + c.gray('   connected now: ') + conn);
    if (st.updated) line(c.gray('  last update: ' + st.updated));
  }
  line(c.gray('  Log: ' + LOG_FILE));
}
