# intelbyte for Windows

**A background app that redacts your email & phone on screen across every CDP app.**
OPSEC for streaming and screen-sharing — no browser extensions, no client mods.

> 🐧 **On Linux?** Use the **[Linux edition](../linux)** in this repo — same
> masking engine, driven from a foreground terminal.

You tell `intelbyte` which of your emails / phone numbers / names to protect.
It then **runs quietly in the background** (with an optional tray icon) and, when
you screen-share or record, any of those values that appear in **Discord**, any
**Chromium browser** (Chrome/Brave/Edge), **Firefox**, or **any Electron app**
(VS Code, Slack, Spotify, Signal, Obsidian, …) are swapped on screen for a stable
fake that looks just like a real one. It works like editing the page with
**Inspect Element**: only the rendered text changes — your real data and any form
values stay exactly as they are.

Phone numbers are matched **in any format** — register `+90 555 111 22 33` and
it's caught as `5551112233`, `905551112233`, `(555) 111 2233`, `0555 111 22 33`,
… (matched by significant digits, ignoring country code, the leading `0`, and
separators). It also fixes the **censored** form (`***********6591` →
`***********0000`). You can also hide **any custom text** — a name, a handle —
with a shape-preserving fake.

> ⚠️ This hides your data **visually** so it doesn't leak in a recording.
> It is not encryption and not a security boundary. The real data is untouched.

## How it works

Discord, the Chromium browsers, and every Electron app are Chromium under the
hood and speak the **Chrome DevTools Protocol (CDP)** when started with
`--remote-debugging-port`. **Firefox** exposes **WebDriver BiDi** on the same
port. intelbyte attaches over that protocol and injects a tiny in-page agent — a
`MutationObserver` that rewrites protected values in visible text, recursing into
iframes and shadow DOM. Editable fields (message box, inputs) are skipped, so
typing and real form values are never touched.

To make apps launch with the debug flag, `intelbyte setup`:

- **rewrites each app's shortcuts** (Start Menu, Desktop, taskbar) to add the
  debug flag, so opening them the normal way comes up ready to mask; and
- the **background shield** watches every wired port and, if it ever sees an app
  running *without* its debug port (launched some other way — a raw `.exe`, the
  Run box), it **relaunches it in debug mode**. That relaunch is the real safety
  net; the shortcut rewrite just avoids an initial flicker.

Nothing is installed *into* any app; the only changes on disk are the shortcut
arguments (reverted by `unsetup`) and a Startup entry (reverted by `uninstall`).

## Install

1. Install **[Node.js 18+](https://nodejs.org)** (LTS is fine).
2. Download / clone this repo and install dependencies:

   ```powershell
   git clone https://github.com/inteIbyte/intelbyte
   cd intelbyte\windows
   npm install
   npm link        # optional: makes `intelbyte` available in any terminal
   ```

   If you didn't `npm link`, run commands as `node bin\intelbyte.js <command>`.

## Quick start

```powershell
# 1) register what to hide
intelbyte protect-mail you@example.com
intelbyte protect-phone "+90 555 111 22 33"
intelbyte protect-custom "Your Name"

# 2) ONE-TIME: wire every CDP app's shortcuts for auto-protection
intelbyte setup

# 3) run it hidden in the background, and start it automatically at every login
intelbyte install

# (optional) put a shield icon in the system tray to control it
intelbyte tray
```

After `install`, the shield runs hidden and masks each wired app the moment you
open it — now and after every reboot. Check on it anytime:

```powershell
intelbyte status
```

## Commands

| Command | What it does |
|---|---|
| `protect-mail <mail...>` | Add email(s) with a random stable fake |
| `protect-phone <number...>` | Add phone(s) with a random fake (same shape) |
| `protect-custom <text...>` | Hide arbitrary text/name with a shape-matching fake |
| `protect-mail custom <real> <fake>` | Pick the fake yourself (phone/custom too) |
| `unprotect-mail` / `-phone` / `-custom <...>` | Remove from protection |
| `list [--reveal]` | Show entries → fakes (real values masked) |
| `regen [value...]` | Regenerate fake(s) |
| `setup` | **One-time:** rewrite every CDP app's shortcuts |
| **`install`** | **Start the hidden background shield + auto-start at login** |
| `tray` | Show a system-tray icon to control the shield |
| `status` | Is the shield running? what's masked? |
| `start` / `stop` / `restart` | Control the background shield |
| `pause` / `resume` | Temporarily stop / resume masking |
| `uninstall` | Stop it and remove the auto-start entry |
| `shield` | Run the shield in **this** window (foreground, for debugging) |
| `unsetup` | Restore all app shortcuts |
| `scrub [browser]` | Purge your entries from Chromium history/autofill (address bar) |
| `firefox-ui-setup [--install]` | EXPERIMENTAL: mask the Firefox address bar (admin) |
| `doctor` | Environment check |

Config (protected values + wired-app registry) lives at
`%APPDATA%\intelbyte\config.json`. The background shield also writes
`status.json` and `shield.log` there.

## The tray icon

`intelbyte tray` shows a shield icon near the clock (a hidden PowerShell
`NotifyIcon`). Right-click it for:

- **status** — running / paused / how many apps are masked right now
- **Pause / Resume masking**
- **Restart shield**
- **Open config folder / shield log**
- **Quit** (stops the background shield)

The tray and the CLI stay in sync — they talk through the same status/pause
files, so `intelbyte pause` and the tray's Pause do the same thing.

## Address bar (native UI)

A page's text is masked live, but the **address bar and autofill popup are drawn
by the browser itself** — no injector can repaint them. So:

- **Chromium (Chrome/Brave/Edge)** — intelbyte **scrubs your protected values out
  of the profile's on-disk stores** (history, typed URLs, search terms, autofill)
  so nothing can be suggested. It runs automatically right before a wired browser
  launches, during `setup`, and on demand:

  ```powershell
  intelbyte scrub            # every installed Chromium browser (must be closed)
  intelbyte scrub brave      # just one
  ```

- **Firefox** — the suggestion text can be masked via a privileged autoconfig:
  `intelbyte firefox-ui-setup --install` (triggers a UAC prompt; experimental).

The only leak neither can stop is **typing the value into the bar yourself on
stream** — those are your live keystrokes, not stored data.

## Architecture

```
src/
  core/          OS-agnostic engine (identical to the Linux edition)
    payload.js     the injected MutationObserver agent
    cdp.js         Chrome DevTools Protocol injector
    bidi.js        Firefox WebDriver BiDi injector
    config.js      protected entries, fakes, masking, registry
    firefoxui.js   Firefox address-bar autoconfig generator
    net.js         port probe
    ui.js          terminal styling + banner
  shield.js      the watch/inject loop (OS-agnostic)
  background.js  hidden worker, start/stop/status, auto-start at login
  cli.js         command parsing
  platform/
    index.js       selects the adapter (guards against wrong OS)
    windows/
      ps.js          PowerShell bridge
      apps.js        shortcut discovery + rewrite, WMI process inspection
      chromium.js    Chromium User Data scrub
      firefox.js     Firefox autoconfig install (elevated)
scripts/
  intelbyte-tray.ps1   system-tray supervisor (NotifyIcon)
```

## Scope & limits (honest)

- ✅ Works in **Discord**, **Chrome / Brave / Edge**, **any Electron app** (CDP),
  and **Firefox** (WebDriver BiDi).
- ✅ Covers **cross-origin iframes** and **shadow DOM**.
- ✅ The swap is real page text in the app's own font — not an overlay.
- ⚠️ A Windows shortcut only covers launches that go *through* it. Launches from a
  raw `.exe` or the Run box are caught by the shield's **relaunch** instead —
  which briefly closes and reopens the app (you may lose the exact URL/args you
  launched with). Wiring the Start-Menu/Desktop/taskbar shortcuts covers the
  common cases without that flicker.
- ⚠️ Remote debugging only opens if the app is the **first** instance to claim its
  profile. If Chrome/Discord is already open, the shield fully closes and reopens
  it once to attach.
- ❌ Does **not** cover native (non-Electron) Win32 apps.
- ❌ Skips editable fields by design (a value inside a "change email" input isn't
  masked).
- Opening an app leaves a **local debug port** listening while it runs — any
  process on the same machine could drive it. `intelbyte unsetup` removes the
  wiring; `intelbyte uninstall` removes the background service.
- `setup`/scrub use PowerShell with `-ExecutionPolicy Bypass` for their own
  scripts only (nothing is left enabled system-wide).

## License

MIT
