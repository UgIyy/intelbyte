// PowerShell bridge. Windows PowerShell 5.1 (powershell.exe) ships with every
// supported Windows, so we target it rather than pwsh. Scripts are fed on stdin
// via `-Command -`, which sidesteps command-line quoting entirely and handles
// multi-line scripts. We keep both a sync runner (one-shot CLI/setup work) and
// an async one (used inside the shield loop so a slow query can't stall it).
import { spawn, spawnSync } from 'child_process';

const PS = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe';

const BASE_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  '-',
];

// Run a script synchronously, return trimmed stdout (throws on non-zero exit).
export function ps(script) {
  const res = spawnSync(PS, BASE_ARGS, {
    input: script,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`powershell exited ${res.status}: ${(res.stderr || '').trim()}`);
  }
  return (res.stdout || '').trim();
}

// Run a script and parse its stdout as JSON. `-Depth` keeps nested objects
// intact; callers should `ConvertTo-Json` themselves so they control shape.
export function psJson(script) {
  const out = ps(script);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// Async variant for the shield loop — never blocks the event loop.
export function psAsync(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(PS, BASE_ARGS, { windowsHide: true });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`powershell exited ${code}: ${errOut.trim()}`));
    });
    child.stdin.end(script);
  });
}

// PowerShell single-quoted string literal (double any embedded quote).
export function psq(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
