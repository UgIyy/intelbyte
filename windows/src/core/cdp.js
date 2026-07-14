// Chrome DevTools Protocol glue for Chromium targets (Discord, Chrome, Brave,
// Edge). It keeps every page injected with the agent and — crucially — registers
// the agent to run at *document-start* on every navigation, so a refreshed or a
// freshly opened page is masked before its first paint (no flash of the real
// value, which the old timer-only approach left for up to one tick on each load).
//
// Per page target we hold ONE persistent CDP connection and:
//   1) Page.addScriptToEvaluateOnNewDocument(agent) — Chromium runs this at
//      document-start on every future navigation/refresh. This is what kills the
//      ~0.5s flash; the connection must stay open, since a preload script is
//      dropped when its client disconnects (the old code reconnected each tick).
//   2) Runtime.evaluate(agent) — masks the page that is already loaded right now.
// We also re-evaluate on Page.loadEventFired / frameNavigated as a backstop, and
// a 2s discovery scan attaches new tabs/windows and prunes closed ones. The agent
// is idempotent (it no-ops when the data is unchanged), so any extra evaluate is
// cheap.
//
// Cross-origin iframes are isolated into separate "OOPIF" targets; we auto-attach
// to them (flatten sessions) and arm + inject there too.
//
// Firefox uses WebDriver BiDi (src/bidi.js), not this module. Firefox's legacy
// CDP accepts addScriptToEvaluateOnNewDocument but won't re-run it after a
// navigation; the periodic re-evaluate below still covers it if this module is
// ever pointed at Firefox.
import CDP from 'chrome-remote-interface';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForEndpoint(port, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await CDP.Version({ port });
      return true;
    } catch {
      await sleep(400);
    }
  }
  return false;
}

export async function startInjector(port, source, onAttach) {
  const clients = new Map(); // targetId -> { client, url }
  const seen = new Set(); // targetIds we've attached to (for count())
  let stopped = false;
  let scanning = false;

  // Register the agent to run at document-start for every future document on
  // this session (top page or a child OOPIF session when sessionId is given).
  async function armPreload(client, sessionId) {
    try {
      if (sessionId) await client.send('Page.enable', {}, sessionId);
      else await client.Page.enable();
    } catch {
      // some targets have no Page domain — ignore
    }
    try {
      if (sessionId) {
        await client.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
      } else {
        await client.Page.addScriptToEvaluateOnNewDocument({ source });
      }
    } catch {
      // unsupported (e.g. Firefox legacy CDP) — the periodic re-evaluate covers it
    }
  }

  // Inject into the document that's loaded right now.
  async function evalNow(client, sessionId) {
    try {
      if (sessionId) {
        await client.send('Runtime.enable', {}, sessionId);
        await client.send('Runtime.evaluate', { expression: source }, sessionId);
      } else {
        await client.Runtime.evaluate({ expression: source });
      }
    } catch {
      // transient — the navigation backstop / next scan retries
    }
  }

  // Pages that were already open when we attach often need a few passes before
  // the agent sticks — stagger re-injects instead of making the user refresh.
  function burstEval(client, sessionId) {
    const delays = [400, 1200, 2800, 5000];
    for (const ms of delays) {
      setTimeout(() => {
        if (stopped) return;
        evalNow(client, sessionId).catch(() => {});
      }, ms);
    }
  }

  async function agentAlive(client, sessionId) {
    try {
      const opts = { expression: '!!(window.__intelbyteAgent && window.__intelbyteAgent.data)', returnByValue: true };
      const res = sessionId
        ? await client.send('Runtime.evaluate', opts, sessionId)
        : await client.Runtime.evaluate(opts);
      return !!(res && res.result && res.result.value);
    } catch {
      return false;
    }
  }

  // One gentle reload when a live http(s) tab resisted injection — replaces
  // the user hammering F5 several times after protection starts.
  async function ensureLivePage(client, target) {
    const url = ((target && target.url) || '').split('#')[0];
    if (!/^https?:\/\//i.test(url)) return;
    await sleep(700);
    if (stopped || (await agentAlive(client))) return;
    await evalNow(client);
    await sleep(500);
    if (stopped || (await agentAlive(client))) return;
    try {
      await client.Page.reload({ ignoreCache: false });
    } catch {
      // ignore — burst eval / next scan still covers it
    }
  }

  async function waitForLoad(client) {
    try {
      const res = await client.Runtime.evaluate({ expression: 'document.readyState', returnByValue: true });
      if (res && res.result && res.result.value === 'loading') {
        await new Promise((resolve) => {
          const done = () => resolve();
          client.once('Page.loadEventFired', done);
          setTimeout(done, 10000);
        });
      }
    } catch {
      // ignore
    }
  }

  // Chromium puts cross-origin iframes in their own OOPIF targets. Auto-attach
  // (flatten) and arm + inject each child session, recursively for nested frames.
  async function wireChildFrames(client) {
    client.on('Target.attachedToTarget', async (params) => {
      const sid = params && params.sessionId;
      if (!sid || stopped) return;
      await armPreload(client, sid);
      await evalNow(client, sid);
      burstEval(client, sid);
      await client
        .send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          sid
        )
        .catch(() => {});
    });
    await client
      .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
      .catch(() => {});
  }

  // Log once per page, and again when it navigates to a new URL.
  function report(id, target) {
    const rec = clients.get(id);
    if (!rec) return;
    const clean = ((target && target.url) || '').split('#')[0];
    if (rec.url !== clean) {
      rec.url = clean;
      if (onAttach) onAttach(target || { id });
    }
  }

  async function attach(target) {
    if (stopped || clients.has(target.id)) return;
    let client;
    try {
      client = await CDP({ target, port });
    } catch {
      return;
    }
    clients.set(target.id, { client, url: null });
    seen.add(target.id);

    // Firefox needs an explicit contextId after a navigation; capture the latest.
    let ctx = null;
    client.on('Runtime.executionContextCreated', (e) => {
      ctx = e.context && e.context.id;
      if (!stopped) evalNow(client).catch(() => {});
    });
    client.on('disconnect', () => {
      clients.delete(target.id);
    });
    // Navigation backstop: the preload already re-ran the agent at document-start,
    // but re-evaluate too (idempotent) in case an event/preload was missed.
    const onNav = () => {
      evalNow(client).catch(() => {});
    };
    client.on('Page.loadEventFired', onNav);
    client.on('Page.domContentLoaded', onNav);
    client.on('Page.frameNavigated', (e) => {
      if (e && e.frame && !e.frame.parentId) onNav(); // top frame only
    });
    client.on('Page.navigatedWithinDocument', onNav);

    try {
      await client.Runtime.enable();
    } catch {
      // ignore
    }
    await armPreload(client); // document-start for every future navigation (no flash)
    await waitForLoad(client);
    // The page that is already open right now:
    try {
      await client.Runtime.evaluate({ expression: source });
    } catch {
      // Firefox after a navigation: retry against the captured context.
      await sleep(350);
      if (ctx != null) {
        await client.Runtime.evaluate({ expression: source, contextId: ctx }).catch(() => {});
      }
    }
    burstEval(client);
    ensureLivePage(client, target).catch(() => {});
    await wireChildFrames(client).catch(() => {});
    report(target.id, target);
  }

  async function scan() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      let targets;
      try {
        targets = await CDP.List({ port });
      } catch {
        return; // endpoint gone (app closed / restarting)
      }
      const pages = targets.filter((t) => t.type === 'page');
      const liveIds = new Set(pages.map((t) => t.id));
      // Prune closed tabs/windows.
      for (const id of [...clients.keys()]) {
        if (!liveIds.has(id)) {
          const rec = clients.get(id);
          clients.delete(id);
          try {
            await rec.client.close();
          } catch {
            // ignore
          }
        }
      }
      // Attach new targets; refresh log + idempotent re-evaluate for known ones.
      for (const t of pages) {
        if (clients.has(t.id)) {
          report(t.id, t);
          evalNow(clients.get(t.id).client).catch(() => {});
        } else {
          // eslint-disable-next-line no-await-in-loop
          await attach(t);
        }
      }
    } finally {
      scanning = false;
    }
  }

  await scan();
  const interval = setInterval(scan, 2000);

  return {
    count: () => seen.size,
    stop() {
      stopped = true;
      clearInterval(interval);
      for (const rec of clients.values()) {
        try {
          rec.client.close();
        } catch {
          // ignore
        }
      }
      clients.clear();
    },
  };
}
