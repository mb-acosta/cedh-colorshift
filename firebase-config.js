// ─────────────────────────────────────────────────────────────────────────
//  FIREBASE CONFIG  —  REPLACE THE VALUES BELOW WITH YOUR OWN
// ─────────────────────────────────────────────────────────────────────────
//
//  How to get these (one-time, ~5 minutes, 100% free):
//
//  1. Go to https://console.firebase.google.com  →  "Add project"
//     (any name, e.g. "commander-wheel"). You can disable Google Analytics.
//
//  2. In the left sidebar:  Build  →  Realtime Database  →  "Create Database".
//       - Pick a location near you.
//       - Start in "Test mode" for now (we lock it down later — see README).
//
//  3. Project settings (gear icon, top-left)  →  scroll to "Your apps"  →
//     click the  </>  (Web) icon  →  register an app (no hosting needed).
//     Firebase shows you a `firebaseConfig = { ... }` object.
//
//  4. Copy each value from that object into the matching field below.
//     IMPORTANT: also make sure `databaseURL` is present (the </> snippet
//     sometimes omits it). It looks like:
//        https://YOUR-PROJECT-default-rtdb.firebaseio.com
//     You can find it on the Realtime Database page, at the top.
//
//  These keys are NOT secret — they are meant to ship in client-side code.
//  Security comes from the database Rules (see README.md), not from hiding them.
// ─────────────────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey: "AIzaSyCzuUDGAEqpCnL_vjzTB9yUM6EaaYTUJWg",
  authDomain: "commander-wheel.firebaseapp.com",
  databaseURL: "https://commander-wheel-default-rtdb.firebaseio.com",
  projectId: "commander-wheel",
  storageBucket: "commander-wheel.firebasestorage.app",
  messagingSenderId: "323975412313",
  appId: "1:323975412313:web:1fed7f7f16ac4f8d4c4f48"
};

// Optional: a shared "event" name so you can run multiple drafts without them
// mixing. Change this string (e.g. "draft-2026-07") to start a fresh pool.
export const EVENT_ID = "default";
