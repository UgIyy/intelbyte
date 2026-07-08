// Linux platform adapter — the OS-specific surface the CLI and shield use.
// Everything here is Linux-flavoured (desktop entries, PATH shims, pgrep/pkill,
// flatpak, XDG paths). The orchestration layer (cli.js, shield.js) talks only
// to this interface, so the Windows build swaps in its own adapter unchanged.
import {
  setupApps,
  removeOverrides,
  removeShims,
  refreshDesktopDatabase,
  runApp,
  runAppArgv,
  inspectAppState,
  runningUnprotected,
  killApp,
} from './apps.js';
import {
  scrubChromium,
  isBrowserRunning,
  installedChromiumBrowsers,
} from './chromium.js';
import * as firefox from './firefox.js';

const platform = {
  name: 'linux',

  // Human-facing nouns the CLI reuses so help text reads naturally per-OS.
  terms: {
    wire: 'launcher override + PATH shim',
    wireVerb: 'wire every CDP app so it always opens in debug mode',
    addrBar: 'address bar / autofill',
  },

  // discovery + wiring
  setupApps,
  unwire(registry) {
    return { overrides: removeOverrides(registry), shims: removeShims(registry) };
  },
  refreshLaunchers: refreshDesktopDatabase,

  // launching + process control
  runApp,
  runAppArgv,
  inspectAppState,
  runningUnprotected,
  killApp,

  // chromium address-bar scrub
  installedChromiumBrowsers,
  isBrowserRunning,
  scrubChromium,

  // firefox address-bar masking (experimental)
  firefox,
};

export default platform;
