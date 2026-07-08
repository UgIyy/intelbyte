# intelbyte (Linux)

**Terminal-driven email & phone redaction across every CDP app.**
OPSEC for streaming and screen-sharing — no browser extensions, no client mods.

> 🪟 **On Windows?** Use the **[Windows edition](../windows)** in this repo —
> same masking engine, but it runs as a background app / tray icon instead of a
> foreground terminal.

You tell `intelbyte` which of your emails / phone numbers to protect. When you
screen-share or record, any of them that appear in **Discord**, any **Chromium
browser** (Chrome/Brave/Edge), **Firefox**, or **any Electron app** (VS Code,
Slack, Spotify, Signal, Obsidian, …) — messages, account settings, any page —
are swapped on screen for a stable fake that looks just like a real one. It works
like editing the page with **Inspect Element**: only the rendered text changes —
your real data and any form values stay exactly as they are.

**Wire it once, then forget it.** `intelbyte setup` finds every CDP/BiDi-capable
app on your system and patches its launcher so it always opens in debug mode.
After that you run the **shield** (`intelbyte`) and it masks each app the moment
you open it — whenever, however you open it — with no per-app commands.

Phone numbers are matched **in any format** — you register one (e.g.
`+90 555 111 22 33`) and it's caught however it shows up on screen:
`5551112233`, `905551112233`, `+905551112233`, `(555) 111 2233`, `0555 111 22 33`, …
(matched by the significant digits, ignoring country code, the leading `0`, and
separators). Unrelated numbers, dates and IDs are left alone.

It also fixes the **censored** form: when an app hides a phone but leaves the
last digits visible (e.g. Discord shows `***********6591`), those trailing real
digits are swapped for the fake's (`***********0000`), so nothing leaks even
before you click "Reveal".

You can also hide **any custom text** — a name, a handle, a tag — with a
shape-preserving fake (`protect-custom`).

> ⚠️ This hides your data **visually** so it doesn't leak in a recording.
> It is not encryption and not a security boundary. The real data is untouched.

## How it works

Discord, the Chromium browsers, and every Electron app are Chromium under the
hood, and speak the **Chrome DevTools Protocol (CDP)** when started with
`--remote-debugging-port`. **Firefox** exposes **WebDriver BiDi** on the same
port (CDP can't reach its cross-origin frames; BiDi can).

CDP/BiDi can only attach to an app that was *launched* with the debug flag, so
intelbyte does it in two parts:

1. **`intelbyte setup`** (one-time) scans your desktop entries, finds every
   CDP-capable app — Chromium browsers and Discord by name, any other **Electron
   app generically** (it has an `app.asar`) — assigns each a stable debug port,
   and writes a launcher override into `~/.local/share/applications` plus a PATH
   shim into `~/.local/bin`. However you start the app (menu, rofi, dock, a URL
   handler, or typing its name in a terminal) it comes up with its debug port on.
2. **`intelbyte`** (the shield) watches all the assigned ports and, the instant
   an app appears, injects a tiny in-page agent — a `MutationObserver` that
   rewrites protected emails/phones in visible text nodes and recurses into
   iframes and shadow DOM. Editable areas (message box, `<input>`/`<textarea>`)
   are skipped, so typing and real form values are never altered.

Nothing is installed *into* any app; the only changes on disk are the launcher
overrides + shims, which `unsetup` reverts.

## What's new in 0.3.0

- **Cross-platform core.** The masking engine, config, and shield loop are now a
  shared `src/core` + `src/shield.js`, with all Linux-specific behaviour behind a
  single platform adapter (`src/platform/linux`). This is what lets the Windows
  edition reuse the exact same engine.
- **`protect-custom`** — hide arbitrary text/names, not just emails and phones.
- **Robust `sql.js` resolution** — the address-bar scrub no longer depends on the
  repo living at a hard-coded path, so you can clone it anywhere.
- **Config respects `XDG_CONFIG_HOME`** (and `INTELBYTE_HOME` still overrides).

## Install

```bash
git clone https://github.com/inteIbyte/intelbyte
cd intelbyte/linux
npm install
npm link        # optional: makes `intelbyte` available globally
```

Requires **Node.js ≥ 18**.

## Usage

```bash
# 1) register what you want hidden (random fake)
intelbyte protect-mail you@example.com
intelbyte protect-phone "+90 555 111 22 33"
intelbyte protect-custom "Your Name"

# ...or pick the fake yourself (custom mapping)
intelbyte protect-mail custom you@example.com fake123@example.com

# 2) see everything + their fakes
intelbyte list

# 3) ONE-TIME: wire every CDP app's launcher for auto-protection
intelbyte setup

# 4) turn on the shield (leave it running while you stream)
intelbyte
```

After `setup`, any wired app you open — now or days later — is masked
automatically by the running shield. Any app that was **already open before
setup** was started without its debug port, so close it fully and reopen it once
(`intelbyte doctor` flags these). Leave the shield terminal open while streaming;
`Ctrl+C` stops it (already-open windows stay masked until they reload).

> 📱 You can type a number with spaces directly — `intelbyte protect-phone 0532 123 45 67`.
> The fragments are rejoined into one number. Quote each number only when adding
> several at once: `intelbyte protect-phone "0532 ..." "0555 ..."`.

### All commands

| Command | What it does |
|---|---|
| `protect-mail <mail...>` | Add email(s) with a random stable fake |
| `protect-mail custom <real> <fake>` | Map an email to a fake you choose |
| `protect-phone <number...>` | Add phone(s) with a random fake (same shape) |
| `protect-phone custom <real> <fake>` | Map a phone to a fake you choose |
| `protect-custom <text...>` | Hide arbitrary text/name with a shape-matching fake |
| `protect-custom-custom <real> <fake>` | Custom text with a fake you choose |
| `unprotect-mail` / `-phone` / `-custom <...>` | Remove from protection |
| `list` | Show protected entries → fakes (real values **masked**) |
| `list --reveal` | Same, but show the real values in full |
| `regen [value...]` | Regenerate fake(s) (no args = all) |
| `setup` | **One-time:** wire every CDP app's launcher for auto-protection |
| `unsetup` | Remove all launcher overrides + shims |
| *(no command)* | **Shield:** watch every wired app and mask it whenever it opens |
| `scrub [browser]` | Purge your entries from Chromium history/autofill (address-bar leak) |
| `firefox-ui-setup [--install]` | EXPERIMENTAL: mask the Firefox address bar (sudo) |
| `doctor` | Environment check (Node, wired apps, which are running protected) |
| `help` | Help |

Config (protected values + the wired-app registry) lives at
`~/.config/intelbyte/config.json` (or `$XDG_CONFIG_HOME/intelbyte`).

### What gets wired

`setup` picks up, from your installed desktop entries:

- **Chromium browsers** — Chrome, Chromium, Brave, Edge (native or flatpak)
- **Firefox** — via WebDriver BiDi (needs Firefox 128 / ESR 128 or older; 129+
  removed the legacy endpoint)
- **Discord** and Discord-family clients (Vesktop, WebCord) — with automatic
  Mullvad split-tunnel so they still connect over a VPN
- **Any other Electron app** — detected generically by its `app.asar`
  (VS Code, Slack, Spotify, Signal, Obsidian, Element, Postman, …)

## Address bar (native UI)

A web page's text is masked live; the **address bar and autofill popup are not a
web page** — they're drawn by the browser itself, and nothing (CDP, BiDi, an
extension) can repaint them. So intelbyte handles them per engine:

- **Chromium** — intelbyte **scrubs your protected email/phone out of the
  profile's on-disk stores** (history, typed URLs, search terms, autofill) so
  nothing can be suggested. Runs automatically when a wired browser launches,
  during `setup`, and on demand via `intelbyte scrub`. A browser locks its
  profile while running, so close it first if it's open.
- **Firefox** — the suggestion text *can* be masked directly via a privileged
  autoconfig: `intelbyte firefox-ui-setup --install` (or it rides along with
  `setup`).

The only leak neither approach can stop is **typing the value into the bar
yourself on stream** — those are your live keystrokes, not stored data.

## Architecture

```
src/
  core/          OS-agnostic engine (identical to the Windows edition)
    payload.js     the injected MutationObserver agent
    cdp.js         Chrome DevTools Protocol injector
    bidi.js        Firefox WebDriver BiDi injector
    config.js      protected entries, fakes, masking, registry
    firefoxui.js   Firefox address-bar autoconfig generator
    net.js         port probe
    ui.js          terminal styling + banner
  shield.js      the watch/inject loop (OS-agnostic)
  cli.js         command parsing
  platform/
    index.js       selects the adapter (guards against wrong OS)
    linux/         desktop entries, PATH shims, pgrep/pkill, flatpak, scrub
```

## Scope & limits (honest)

- ✅ Works in **Discord desktop**, **Chrome / Brave / Edge**, **any Electron app**
  (CDP), and **Firefox** (WebDriver BiDi).
- ✅ Covers **cross-origin iframes** and **shadow DOM** (e.g. Google's account
  popup).
- ✅ The swap is real page text in the app's own font — not an overlay.
- ⚠️ The browser's **own address/search bar** and autofill popup are native UI —
  handled at the source (scrub / Firefox autoconfig), not by masking.
- ❌ Does **not** cover native (non-Electron) apps.
- ❌ Skips editable fields by design (a value inside a "change email" input is
  not masked).
- An app must be **launched with the debug flag** to be attachable; one already
  running from before `setup` is unprotected until you close and reopen it.
- Opening an app leaves a **local debug port** listening while it runs — any
  process on the same machine could drive it. `intelbyte unsetup` removes it.

## License

MIT
