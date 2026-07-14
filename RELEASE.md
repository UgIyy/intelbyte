# GitHub release (Windows)

IntelByte desktop app lives in this repo (`linux/` + `windows/`). The website repo is separate.

## New GitHub account

1. Log into the **new** GitHub account in the browser.
2. Create an empty repo (e.g. `intelbyte`) — **no** README, **no** `.gitignore`.
3. On your PC, from this folder:

```powershell
cd "C:\Users\Ugly\Desktop\intelbyte-repo"

# point at the new account (replace NEWUSER and REPO)
git remote add publish https://github.com/NEWUSER/REPO.git

git add -A
git status   # confirm: no .env, no windows/dist/, no secrets

git commit -m "IntelByte v0.3.0 — Windows portable release"
git push -u publish main
```

4. Tag and push (triggers the Windows build workflow if Actions are enabled):

```powershell
git tag v0.3.0
git push publish v0.3.0
```

5. On GitHub → **Actions** → wait for **Release Windows** → the zip appears on **Releases**.

## Manual release (no Actions)

```powershell
cd windows
npm run build:exe
```

Upload `windows/dist/IntelByte-Windows.zip` on GitHub → Releases → New release → attach file.

## What users download

- **IntelByte-Windows.zip** — unzip, run `IntelByte.exe` (no Node install).
- First-time setup:

```powershell
.\IntelByte.exe protect-mail you@example.com
.\IntelByte.exe setup
.\IntelByte.exe install
```
