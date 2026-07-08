// Mullvad split-tunnel support for Discord-family apps (Linux only).
//
// Discord's API/gateway is fronted by Cloudflare, which rejects clients coming
// from VPN/datacenter exit IPs with HTTP 403 `code: 40333 "internal network
// error"` — Discord just shows "network error / temporarily unavailable". When
// the user is on Mullvad, every exit is a datacenter ASN, so Discord can't
// connect at all (this is independent of intelbyte's debug port). Fix: launch
// Discord OUTSIDE the tunnel via `mullvad-exclude`, so it uses the real
// residential IP while the VPN stays up system-wide. Other traffic is untouched.
import { existsSync, readdirSync } from 'fs';
import { load } from '../../core/config.js';

const MULLVAD_EXCLUDE = '/usr/bin/mullvad-exclude';

function mullvadActive() {
  // A *mullvad* netdev exists only while a tunnel is up.
  try {
    return readdirSync('/sys/class/net').some((n) => n.includes('mullvad'));
  } catch {
    return false;
  }
}

// Returns the split-tunnel command prefix (e.g. ['mullvad-exclude']) or [].
// Config `discordSplitTunnel`: 'auto' (default) wraps only when Mullvad is up;
// true always wraps (if the binary exists); false never wraps.
export function splitTunnelPrefix(mode = load().discordSplitTunnel) {
  if (mode === false) return [];
  if (!existsSync(MULLVAD_EXCLUDE)) return [];
  if (mode === true) return [MULLVAD_EXCLUDE];
  return mullvadActive() ? [MULLVAD_EXCLUDE] : []; // 'auto'
}

// Whether a split-tunneled launch will be routed outside the VPN (status notes).
export function isSplitTunneled() {
  return splitTunnelPrefix().length > 0;
}
