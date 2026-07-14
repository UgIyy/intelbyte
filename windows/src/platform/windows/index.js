// Windows platform adapter — the OS-specific surface the CLI and shield use.
// Presents the exact same interface as the Linux adapter, so cli.js / shield.js
// don't know or care which OS they're on.
import {
  setupApps,
  unwireShortcuts,
  runApp,
  runAppArgv,
  inspectAppState,
  runningUnprotected,
  killApp,
  relaunchApp,
  relaunchUnprotectedApps,
} from './apps.js';
import { scrubChromium, isBrowserRunning, installedChromiumBrowsers } from './chromium.js';
import * as firefox from './firefox.js';

const platform = {
  name: 'windows',

  terms: {
    wire: 'shortcut',
    wireVerb: 'rewrite each app shortcut so it always opens in debug mode',
    addrBar: 'address bar / autofill',
  },

  // discovery + wiring
  setupApps,
  unwire(registry) {
    return { overrides: unwireShortcuts(registry), shims: [] };
  },
  refreshLaunchers() {}, // no-op on Windows (shortcuts take effect immediately)

  // launching + process control
  runApp,
  runAppArgv,
  inspectAppState,
  runningUnprotected,
  killApp,
  relaunchApp,
  relaunchUnprotectedApps,

  // chromium address-bar scrub
  installedChromiumBrowsers,
  isBrowserRunning,
  scrubChromium,

  // firefox address-bar masking (experimental)
  firefox,
};

export default platform;
