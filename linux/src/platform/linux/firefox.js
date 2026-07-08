// EXPERIMENTAL: install/remove Firefox address-bar masking (Linux).
//
// The URL bar is browser chrome, not a web page, so the injectors can't reach
// it. Firefox's "autoconfig" runs privileged JS in the chrome context at
// startup — that's the only way in. This module stages the generated .cfg +
// activator pref (content comes from core/firefoxui.js) and installs them into
// Firefox's application directory (needs root, so we shell out to sudo).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  buildMozillaCfg,
  buildAutoconfigPref,
  cfgFileName,
  prefFileName,
} from '../../core/firefoxui.js';
import { buildPayloadData, load, configDir } from '../../core/config.js';

const FF_APP_DIRS = [
  '/usr/lib/firefox-esr',
  '/usr/lib/firefox',
  '/usr/lib64/firefox',
  '/opt/firefox',
  '/opt/firefox-esr',
];

export function appDir() {
  for (const d of FF_APP_DIRS) if (existsSync(d)) return d;
  return null;
}

// Re-bake the staged Firefox autoconfig (cfg + activator pref) from the current
// entries and report install state. Returns null if there's nothing to protect.
export function stage() {
  const data = buildPayloadData(load());
  if (!data.emails.length && !data.phones.length) return null;
  const dir = join(configDir(), 'firefox');
  mkdirSync(dir, { recursive: true });
  const cfgStage = join(dir, cfgFileName());
  const prefStage = join(dir, prefFileName());
  const cfgText = buildMozillaCfg(data);
  const prefText = buildAutoconfigPref();
  writeFileSync(cfgStage, cfgText);
  writeFileSync(prefStage, prefText);

  const dst = appDir();
  const cfgDest = dst ? `${dst}/${cfgFileName()}` : null;
  const prefDir = dst ? `${dst}/defaults/pref` : null;
  const prefDest = prefDir ? `${prefDir}/${prefFileName()}` : null;

  let installed = false;
  let current = false;
  if (cfgDest && existsSync(cfgDest)) {
    installed = true;
    try {
      current =
        readFileSync(cfgDest, 'utf8') === cfgText &&
        !!prefDest &&
        existsSync(prefDest) &&
        readFileSync(prefDest, 'utf8') === prefText;
    } catch {
      current = false;
    }
  }
  return { appDir: dst, cfgStage, prefStage, cfgDest, prefDir, prefDest, installed, current };
}

// Copy the staged files into the Firefox app dir via sudo (prompts in the
// user's terminal). Returns true on success.
export function install(st) {
  const sh =
    `install -m 0644 '${st.cfgStage}' '${st.cfgDest}' && ` +
    `install -d '${st.prefDir}' && ` +
    `install -m 0644 '${st.prefStage}' '${st.prefDest}'`;
  return spawnSync('sudo', ['sh', '-c', sh], { stdio: 'inherit' }).status === 0;
}

// Shell commands the user can run to remove the masking (printed by the CLI).
export function removeCommands() {
  const dst = appDir();
  if (!dst) return null;
  return [
    `sudo rm -f "${dst}/${cfgFileName()}"`,
    `sudo rm -f "${dst}/defaults/pref/${prefFileName()}"`,
  ];
}
