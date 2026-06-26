# 🎡 Commander Wheel

A free, static web app for Commander (EDH) playgroups. Players type their Discord
name and spin a wheel to get randomly assigned a commander.

- Land on a **commander** → that commander is removed from the wheel for everyone.
- Land on **PARTNER** → a second wheel loads; spin twice to get a partner pair
  (e.g. `A + B`). A single partner can be rolled by multiple players, but the
  **exact pair** (`A + B`) can only be claimed once.
- Every assignment is saved to a shared database and shown live to everyone on
  any device.

Built with plain HTML/CSS/JavaScript + Firebase Realtime Database. No build step.
Hosts for free on GitHub Pages.

---

## Files

| File | What it is |
|------|------------|
| `index.html` | The page |
| `app.js` | All the logic (wheel, weighting, partner pairing, DB writes) |
| `styles.css` | Styling |
| `commanders.js` | The commander list + card-art Google Drive IDs (auto-generated from `Commander list.xlsx`) |
| `firebase-config.js` | **You edit this** — your Firebase keys |
| `database.rules.json` | Security rules to paste into Firebase |

---

## Step 1 — Create a free Firebase database (~5 min)

1. Go to <https://console.firebase.google.com> → **Add project**. Name it
   anything (e.g. `commander-wheel`). Google Analytics can be disabled.
2. Left sidebar → **Build → Realtime Database → Create Database**. Choose a
   location, and start in **Test mode**.
3. Top-left **gear → Project settings** → scroll to **Your apps** → click the
   **`</>`** (Web) icon → register an app (you do *not* need Firebase Hosting).
4. Firebase shows a `const firebaseConfig = { ... }` block. Copy each value into
   the matching field in **`firebase-config.js`** in this project.
   - Make sure **`databaseURL`** is filled in. If the snippet didn't include it,
     copy it from the top of the Realtime Database page — it looks like
     `https://your-project-default-rtdb.firebaseio.com`.

### Lock down the database (recommended)

Test mode lets anyone write for 30 days, then blocks everything. Replace the
rules so the app keeps working but only the assignments path is open:

- Realtime Database → **Rules** tab → paste the contents of
  `database.rules.json` → **Publish**.

> These rules allow anyone with the link to read and add assignments (fine for a
> playgroup). They don't allow editing/deleting existing entries from the client.
> To wipe the pool between drafts, either use **Admin mode** (below) or change
> `EVENT_ID` in `firebase-config.js` to a new value (e.g. `"draft-2026-07"`).

---

## Step 2 — Put it on GitHub Pages (free hosting)

1. Create a new GitHub repo and upload **all** the files in this folder
   (you can drag-and-drop them into the repo's web page, or use git).
   - You don't need to upload `Commander list.xlsx` — it's only the source for
     `commanders.js`. Keeping it is harmless.
2. Repo → **Settings → Pages** → under "Build and deployment", set
   **Source = Deploy from a branch**, **Branch = `main` / `(root)`** → Save.
3. Wait ~1 minute. Your site appears at
   `https://YOUR-USERNAME.github.io/YOUR-REPO/`. Share that link.

The included `.nojekyll` file makes sure GitHub Pages serves everything as-is.

---

## Using it

- Everyone opens the link, **registers** a simple account (Discord username +
  password — no email), and hits **SPIN**. Their result is saved to the shared
  list and tied to their account.
- **Guest Spin** rolls for fun without an account and **never saves** anything.
  It spins across **every commander — even ones already claimed** (single or
  partner combo); the real pool and the assignments list are untouched.
- The **Assignments** panel updates live on every device.
- It also works if one person drives a single shared screen — same result.

### Accounts

- **Register / Log in** at the top of the wheel with a Discord username (free
  text, exactly as you like it) and a password. No email or contact info is
  collected or required.
- **Remember me** (checked by default) keeps you logged in across browser
  restarts (a pointer is kept in `localStorage` — never your password). Uncheck
  it on a shared computer and you'll only stay logged in until the tab/browser
  closes (`sessionStorage`). **Log out** clears both.
- A saved spin requires being logged in; **Guest Spin** does not.
- Your identity is just your (lower-cased) username, so if you played as
  `coolguy` with the old free-text box and later register `coolguy`, your past
  results line up automatically — nothing is lost when accounts are introduced.

> **Password security (read this).** This is a static, server-less app, so
> passwords are hashed **in the browser** with PBKDF2-SHA256 (150k iterations)
> and a unique random salt; only the hash + salt are stored. The plaintext
> password is never stored or sent anywhere. This is **good enough for a Discord
> playgroup, not bank-grade**: under the open database rules below the hashes are
> technically readable, so a determined attacker could try to brute-force weak
> passwords. Don't reuse an important password here. Account records are
> **create-only** (the rules block overwriting an existing username), so accounts
> can't be hijacked or have their password changed from the client. There is no
> password reset — pick something you'll remember.

### Admin mode

Admin is tied to **one account**, not a shareable link. First-time setup:

1. Register/log in with the account you want to be the organizer.
2. Add `#admin` to the URL once (e.g. `…github.io/your-repo/#admin`) — a
   **“Make this account the admin”** bar appears. Click it. This writes the
   owner once and locks it (create-only), so it can't be taken or changed from
   the app afterward. **Do this right after you deploy**, before sharing the
   link, so nobody can claim it first.

From then on the admin tools appear **automatically whenever the owner account
is logged in** — `#admin` is no longer needed, and a leaked `#admin` link does
nothing for anyone who isn't logged in as the owner. (To move admin to a
different account later, delete `admin/owner` in the Firebase console, then
claim again.)

> Note: this gates the **admin UI** behind a password-protected account, which
> stops casual misuse of a leaked link. It does **not** make the database
> tamper-proof — under the open rules a determined person could still write via
> the API. True enforcement would need Firebase Auth or a backend.

The admin tools are:

- **📦 Store event & reset pool** — archives every current result, then returns
  **all** commanders to the pool for a new event. Each player keeps their stored
  result and **can't re-roll that exact result again** (a single they got is
  blocked as a single; a partner pair blocks only that exact pair). Past events
  are saved under `events/<id>/archives` for the record.
- **Reset all assignments** — wipes the current event's assignments **without**
  storing them (the old behavior). Use *Store event & reset* instead if you want
  to keep the results.
- **↻ Re-roll** (on each result row) — removes that player's result and frees it
  back to the pool so they can spin again. **✕** removes a result outright.
- **Manually assign a commander** — pick/type a username, choose a single or a
  partner pair, and assign it directly. Useful for hand-assigning or for
  re-attaching existing results to a player without anyone re-rolling.
- **Account badge** — in the Assignments list, each result shows a small
  **✓ account** (a registered account exists for that name) or **no account**
  (nobody has registered that username yet). Handy for seeing which existing
  results are already backed by a login. It refreshes when admin loads/acts; the
  list reflects accounts known at that time.

---

## Tweaks

- **Partner odds** — top of `app.js`, the `PARTNER_ODDS` constant:
  - `"cards"` (default) → PARTNER lands ~26% of the time at the start.
  - `"combos"` → PARTNER lands ~80% of the time early (very partner-heavy).
  - a number (e.g. `30`) → fixed weight for the whole PARTNER slice.
- **Commander list** — edit `commanders.js` directly (add/remove entries, set
  `partner: true/false`, set `back` for flip cards), or re-generate it from a new
  spreadsheet.
- **Card art** — comes from the `img` / `backImg` Google Drive file IDs in
  `commanders.js`, served via `https://lh3.googleusercontent.com/d/<id>=w480`.
  Each card file must be shared **"Anyone with the link"** or the image silently
  hides (the rest of the app keeps working). To use your own image host instead,
  change the `driveImg()` function near the top of `app.js`.
- **Run a fresh draft** without deleting history — change `EVENT_ID` in
  `firebase-config.js`.

---

## Local preview

Because it uses ES modules, open it through a tiny local server rather than
double-clicking the file:

```
# from this folder, with Python installed:
python -m http.server 8000
# then visit http://localhost:8000
```

If `firebase-config.js` still has `REPLACE_ME` values, the app runs in a local
preview mode (assignments are kept only in your browser tab, not shared).
