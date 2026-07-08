<h1 align="center">🛡️ intelbyte</h1>

<p align="center">
  <b>Hide your email &amp; phone on screen — across every app — while you stream.</b><br>
  OPSEC for screen-sharing and recording. No browser extensions, no client mods.
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20Windows-blue">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey">
  <img alt="deps" src="https://img.shields.io/badge/deps-3-9cf">
</p>

---

You register the emails, phone numbers, and names you want to protect. When you
screen-share or record, intelbyte swaps them **on screen** for a stable fake that
looks just like a real one — in **Discord**, any **Chromium browser**
(Chrome/Brave/Edge), **Firefox**, and **any Electron app** (VS Code, Slack,
Spotify, Signal, Obsidian, …).

It works exactly like editing the page with **Inspect Element**: only the
*rendered* text changes. Your real data, your logins, and anything you type are
never touched.

> [!WARNING]
> intelbyte hides your data **visually** so it doesn't leak in a recording.
> It is **not** encryption and **not** a security boundary — the real data is
> untouched underneath.

## What it looks like

You register a value once, and everywhere it would appear on screen it's shown as
its fake instead:

| You register | On your real screen it stays | On the recording / stream it shows |
|---|---|---|
| `you@example.com` | `you@example.com` | `k7f3qz@example.com` |
| `+90 555 111 22 33` | `+90 555 111 22 33` | `+90 312 908 44 61` |
| `Jane Doe` (custom) | `Jane Doe` | `Mkxw Rce` |

- **Any phone format** is caught from one entry — `5551112233`, `905551112233`,
  `(555) 111 2233`, `0555 111 22 33` all map to the same fake (matched by the
  significant digits, ignoring country code, the leading `0`, and separators).
- Even the **censored** form is fixed — when Discord shows `***********2233`, the
  real trailing digits are swapped too (`***********4461`).
- Unrelated numbers, dates and IDs are left alone.

## Two editions

Both editions share the **exact same masking engine** (`src/core` + the shield
loop) — they differ only in how they run.

| | 🐧 **[Linux](./linux)** | 🪟 **[Windows](./windows)** |
|---|---|---|
| How it runs | Foreground **CLI shield** you keep open while streaming | **Hidden background app** + optional **system-tray icon**, auto-starts at login |
| Wires apps via | `.desktop` launcher overrides + PATH shims | Start-Menu / Desktop / taskbar **shortcut** rewrites |
| Turn it on | `intelbyte setup` → `intelbyte` | `intelbyte setup` → `intelbyte install` |
| Extras | Mullvad split-tunnel for Discord | tray, `install` / `start` / `stop` / `status` / `pause` |

→ Full docs: **[linux/README.md](./linux/README.md)** · **[windows/README.md](./windows/README.md)**

## Quick start

<details open>
<summary><b>🐧 Linux</b></summary>

```bash
cd linux
npm install
npm link                                   # optional: `intelbyte` everywhere

intelbyte protect-mail you@example.com     # 1) register what to hide
intelbyte protect-phone "+90 555 111 22 33"
intelbyte protect-custom "Jane Doe"

intelbyte setup                            # 2) one-time: wire every CDP app
intelbyte                                  # 3) run the shield while you stream
```
</details>

<details>
<summary><b>🪟 Windows</b> (PowerShell)</summary>

```powershell
cd windows
npm install
npm link

intelbyte protect-mail you@example.com     # 1) register what to hide
intelbyte protect-phone "+90 555 111 22 33"
intelbyte protect-custom "Jane Doe"

intelbyte setup                            # 2) one-time: wire every CDP app
intelbyte install                          # 3) run it hidden in the background
intelbyte tray                             # (optional) tray icon to control it
```
</details>

Requires **[Node.js 18+](https://nodejs.org)**.

## How it works

Discord, the Chromium browsers, and every Electron app are Chromium under the
hood and speak the **Chrome DevTools Protocol (CDP)** when launched with
`--remote-debugging-port`. **Firefox** exposes **WebDriver BiDi** on the same
port (CDP can't reach its cross-origin frames; BiDi can). intelbyte attaches over
that protocol and injects a tiny in-page agent — a `MutationObserver` that
rewrites your protected values in visible text, recursing into **iframes** and
**shadow DOM**. Editable fields (the message box, `<input>`/`<textarea>`) are
skipped, so typing and real form values are never altered.

Because that protocol only attaches to an app **launched with the debug flag**,
`intelbyte setup` makes every future launch turn it on (launcher overrides on
Linux, shortcut rewrites on Windows), and the running shield injects the masking
agent the instant an app appears.

```
you open Discord ──▶ it comes up with its debug port on ──▶ shield attaches
                                                             └▶ your email/phone
                                                                masked before the
                                                                first paint
```

## What it covers

- ✅ **Discord**, **Chrome / Brave / Edge**, **any Electron app** (CDP), and
  **Firefox** (WebDriver BiDi)
- ✅ **Cross-origin iframes** and **shadow DOM** (e.g. Google's account popup)
- ✅ The swap is real page text in the app's own font — not an overlay, no lag
- ✅ **Address bar / autofill** — native browser UI no injector can repaint, so
  intelbyte kills the leak at the source instead: it **scrubs** your values out of
  the Chromium profile's history/autofill, and masks Firefox's suggestions via a
  privileged autoconfig

### Honest limits

- ❌ Native (non-Electron) apps — there's no clean OS API to rewrite their text
- ❌ A value shown **inside an editable input** (a "change email" box) is skipped
  by design
- ⚠️ An app already open **before** protection was on has no debug port — close
  and reopen it once (the shield can also relaunch it for you)
- ⚠️ An open debug port is a **local** attack surface (any process on your machine
  could drive that app); `unsetup` removes the wiring

## Repository layout

```
intelbyte/
├── linux/            🐧 Linux edition (CLI shield)
│   └── src/
│       ├── core/            OS-agnostic masking engine  (identical across editions)
│       ├── shield.js        watch + inject loop          (identical across editions)
│       └── platform/linux/  desktop entries, PATH shims, pgrep, profile scrub
├── windows/          🪟 Windows edition (background app + tray)
│   └── src/
│       ├── core/               (same engine)
│       ├── background.js       hidden worker, auto-start, start/stop/status
│       └── platform/windows/   shortcut rewrites, WMI, PowerShell bridge
└── README.md         (this file)
```

The two editions are self-contained (each has its own `package.json`), so you
only install and run the one for your OS.

## License

[MIT](./LICENSE) — do whatever you want, no warranty.
