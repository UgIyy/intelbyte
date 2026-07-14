// The shield: watch every wired app's debug port and inject the masking agent
// the instant the app appears. OS-agnostic — all platform-specific behaviour
// (process inspection, relaunching) comes through the injected `platform`
// adapter, so this exact file ships in both the Linux and Windows editions.
import { buildPairs, buildPayloadData, maskValue } from './core/config.js';
import { buildPayload } from './core/payload.js';
import { probePort } from './core/net.js';
import { startInjector } from './core/cdp.js';
import { startBidiInjector } from './core/bidi.js';
import { banner, title, ok, warn, info, line, c, sleep } from './core/ui.js';

// Run the shield until Ctrl+C (or the returned stop() is called). `opts.quiet`
// suppresses the banner/interactive chrome for background use; `opts.onEvent`
// receives structured status updates (used by the Windows tray / status file).
export async function runShield(platform, cfg, opts = {}) {
  const quiet = !!opts.quiet;
  const emit = opts.onEvent || (() => {});
  const apps = cfg.apps || {};
  const ids = Object.keys(apps);
  const pairs = buildPairs(cfg);

  if (!quiet) {
    await banner();
    title('intelbyte • shield');
  }

  if (!pairs.length) {
    if (!quiet)
      warn(
        'Nothing to protect yet. Add first: ' +
          c.cyan('intelbyte protect-mail <mail>') +
          c.gray(' / ') +
          c.cyan('intelbyte protect-phone <number>')
      );
    emit({ type: 'idle', reason: 'no-entries' });
    return null;
  }
  if (!ids.length) {
    if (!quiet) warn('No apps wired yet. One-time: ' + c.cyan('intelbyte setup'));
    emit({ type: 'idle', reason: 'no-apps' });
    return null;
  }

  const autoRelaunch = cfg.autoRelaunch !== false; // default on

  if (!quiet) {
    ok('Masked entries:');
    for (const [real, fake] of pairs) {
      line(`  ${c.gray(maskValue(real))} ${c.gray('→')} ${c.green(fake)}`);
    }
    line('');
    ok('Watching:');
    const w = Math.max(...ids.map((id) => apps[id].label.length));
    for (const id of ids) {
      const a = apps[id];
      line(`  ${c.cyan(a.label.padEnd(w))}  ${c.gray(`port ${a.port} · ${a.protocol}`)}`);
    }
    line('');
    if (autoRelaunch) {
      line(
        c.gray('  If a watched app is open without its debug port (launched any other way),') +
          '\n' +
          c.gray('  the shield closes and reopens it in debug mode so it gets masked.')
      );
      line('');
    }
  }

  const source = buildPayload(buildPayloadData(cfg));
  const active = new Map(); // id -> injector (port open + injected)
  const starting = new Set(); // injector being set up
  const misses = new Map(); // consecutive port-gone ticks (for detaching)
  const unprotHits = new Map(); // consecutive "running unprotected" ticks (debounce)
  const relaunchTries = new Map(); // relaunch attempts since last protected/stopped
  const busy = new Set(); // id currently being killed+relaunched
  const gaveUp = new Set(); // stopped trying after too many failed relaunches
  const MAX_TRIES = 3;
  let stopped = false;

  async function ensureProtected(id) {
    const a = apps[id];
    if (busy.has(id) || gaveUp.has(id)) return;
    const state = await platform.inspectAppState(a);
    if (state === 'stopped') {
      unprotHits.delete(id);
      relaunchTries.delete(id);
      return;
    }
    if (state === 'protected') {
      // running with the flag — its port will open shortly; just wait.
      unprotHits.delete(id);
      return;
    }
    // state === 'unprotected' — debounce one extra tick to avoid racing a launch.
    const hits = (unprotHits.get(id) || 0) + 1;
    unprotHits.set(id, hits);
    if (hits < 2) return;
    unprotHits.delete(id);

    const tries = relaunchTries.get(id) || 0;
    if (tries >= MAX_TRIES) {
      gaveUp.add(id);
      if (!quiet)
        warn(
          `${a.label}: couldn't get it into debug mode after ${MAX_TRIES} tries — giving up. ` +
            'Try ' + c.cyan('intelbyte run-app ' + id) + ' manually.'
        );
      emit({ type: 'gaveup', id, label: a.label });
      return;
    }
    busy.add(id);
    relaunchTries.set(id, tries + 1);
    if (!quiet) warn(`${a.label} is open WITHOUT protection — closing & reopening it in debug mode…`);
    emit({ type: 'relaunch', id, label: a.label });
    try {
      await platform.relaunchApp(id);
    } catch {
      // next tick retries
    } finally {
      busy.delete(id);
    }
  }

  async function tick() {
    if (stopped) return;
    // Background pause (Windows tray "Pause"): stop touching apps but keep the
    // loop alive so Resume is instant. No-op when no pause hook is supplied.
    if (opts.isPaused && opts.isPaused()) {
      emit({ type: 'paused', connected: [...active.keys()] });
      return;
    }
    // Probe every port in parallel so a slow/closed port can't delay the others.
    const states = await Promise.all(
      ids.map((id) => probePort(apps[id].port).then((live) => [id, live]))
    );
    for (const [id, live] of states) {
      if (stopped) return;
      const a = apps[id];
      if (live) {
        misses.delete(id);
        unprotHits.delete(id);
        relaunchTries.delete(id);
        gaveUp.delete(id);
        if (active.has(id) || starting.has(id)) continue;
        starting.add(id);
        const start = a.protocol === 'bidi' ? startBidiInjector : startInjector;
        start(a.port, source, (t) => {
          if (!quiet)
            info(`${a.label}: masked ${c.gray((t.url || t.title || t.id || '').slice(0, 90))}`);
          emit({ type: 'masked', id, label: a.label, url: t.url || t.title || t.id || '' });
        })
          .then((inj) => {
            if (stopped) return inj.stop();
            active.set(id, inj);
            if (!quiet) ok(`${a.label} ${c.bold('connected')} — live masking on.`);
            emit({ type: 'connected', id, label: a.label });
          })
          .catch(() => {}) // endpoint warming up — next tick retries
          .finally(() => starting.delete(id));
      } else if (active.has(id)) {
        // two consecutive misses = the app really closed (not a probe hiccup)
        const m = (misses.get(id) || 0) + 1;
        misses.set(id, m);
        if (m >= 2) {
          active.get(id).stop();
          active.delete(id);
          misses.delete(id);
          if (!quiet) info(`${a.label} closed — waiting for its next launch.`);
          emit({ type: 'closed', id, label: a.label });
        }
      } else if (autoRelaunch) {
        // port closed and not attached — is the app running unprotected?
        await ensureProtected(id);
      }
    }
    emit({ type: 'tick', connected: [...active.keys()] });
  }

  let ticking = false;
  const safeTick = async () => {
    if (ticking) return; // never let two ticks run at once
    ticking = true;
    try {
      await tick();
    } finally {
      ticking = false;
    }
  };
  await safeTick();
  const interval = setInterval(safeTick, 1500);

  if (!quiet) {
    ok(c.bold('Shield active.') + ' Open any wired app, whenever — it attaches by itself.');
    line(c.gray('  Keep this window open. Stop with ') + c.bold('Ctrl+C') + c.gray('.'));
  }
  emit({ type: 'active', apps: ids.length });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    for (const inj of active.values()) inj.stop();
    emit({ type: 'stopped' });
  };

  return { stop, active: () => [...active.keys()] };
}

// Foreground shield for the CLI: runs until Ctrl+C.
export async function runShieldForeground(platform, cfg) {
  const handle = await runShield(platform, cfg);
  if (!handle) return;

  const shutdown = () => {
    handle.stop();
    line('');
    info('Shield stopped. (Open windows stay masked until they reload.)');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}
