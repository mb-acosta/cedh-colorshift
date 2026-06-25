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

- Everyone opens the link, types their Discord name, and hits **SPIN**.
- The **Assignments** panel updates live on every device.
- It also works if one person drives a single shared screen — same result.

### Admin mode (reset the pool)

Add `#admin` to the URL (e.g. `…github.io/your-repo/#admin`). A red bar appears
with a **Reset all assignments** button that clears the current event. There's no
password, so only share the `#admin` link with the organizer.

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
