// Shared, OS-agnostic network helpers for the shield.
import { connect } from 'net';

// Fast liveness probe: is anything listening on the app's debug port?
// Resolves true/false, never throws or hangs (700ms cap).
export function probePort(port) {
  return new Promise((resolve) => {
    const s = connect({ port, host: '127.0.0.1' });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    s.setTimeout(700, () => finish(false));
  });
}
