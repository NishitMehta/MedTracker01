# Taper — Medicine Schedule + Reminders

A lightweight, installable PWA for tracking medicines, building **taper-down plans**, and syncing
each dose to **Google Calendar** so reminders fire even when the app is closed. Pure HTML/CSS/JS —
no build step, no backend. Everything lives on your device; the app talks to Google directly from
the browser.

## Features

- **Today view** — every dose for the day, check them off, live adherence ring, overdue/due highlighting.
- **Fixed schedules** — a steady dose at one or more times, with an end date or ongoing.
- **Taper-down plans** — two kinds:
  - **Dose taper:** define steps (e.g. 40 mg × 5 days → 30 mg × 5 days → …); the app works out
    which dose applies on each date and draws a descending taper ramp.
  - **Spacing taper:** same dose, but the gap between doses grows each time (e.g. 1, 2, 3, 4 days
    apart). Set the first gap, how much it increases, and the number of doses; a live preview shows
    the exact dose dates so you can match your prescription before saving.
- **Google Calendar sync** — each medicine becomes recurring calendar events with popup reminders.
  This is what gives you reliable, always-on reminders.
- **In-app reminders** — local notifications at dose time while the app is open.
- **Offline** — works without a connection; installable to your home screen.
- **Export / import** — back up everything to a JSON file.

## Run it locally

A service worker needs a real origin (not the `file://` protocol), so serve the folder:

```bash
cd medtaper
python3 -m http.server 8080
# open http://localhost:8080
```

## Deploy to GitHub Pages

1. Create a repo and push these files to the root (or a `/docs` folder).
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick your
   branch and `/ (root)`.
3. Your app will be live at `https://<your-username>.github.io/<repo>/`.

All paths in the app are relative, so it works from a subfolder without changes.

## Connect Google Calendar (one-time, ~3 minutes)

The app uses Google's browser sign-in, so you supply your own OAuth **Client ID**. No secret is
needed and nothing is stored on a server.

1. Open [console.cloud.google.com](https://console.cloud.google.com) and create a project.
2. **APIs & Services → Library** → search **Google Calendar API** → **Enable**.
3. **APIs & Services → OAuth consent screen** → choose **External** → fill the basics →
   under **Test users**, add your own Google address. (Leaving the app in "Testing" is fine for
   personal use.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   Application type **Web application**.
5. Under **Authorized JavaScript origins**, add the exact origin the app runs at — origin only, no path:
   - `https://<your-username>.github.io`
   - `http://localhost:8080` (if testing locally)
6. Create, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).
7. In the app: **Settings → Google Calendar sync → on**, paste the Client ID, pick a reminder lead
   time, then **Connect Google account**. Saving a medicine after that pushes its doses to your calendar.

To remove the calendar events later, delete the medicine in the app (its events are removed too), or
use **Settings → Remove all Taper events from calendar** to clear everything Taper ever created —
including any leftovers from an interrupted sync. If you delete a medicine while not signed in, the
cleanup is queued and runs automatically the next time you connect.

## Signing in to Google (and why it's not every time)

A static, backend-free app can't store a permanent Google login — Google's browser sign-in issues
an access token that lasts about an hour and isn't meant to be kept forever. The app handles this by:

- **Remembering the token while it's valid**, so reopening the app within ~an hour needs no sign-in.
- **Only asking you to sign in when you actually add or change a medicine** (or tap the calendar
  pill). It never forces a sign-in just because you opened the app.

For normal use — viewing today's doses, ticking them off, getting reminders — **you don't need to be
signed in at all**. The calendar events already exist in Google Calendar and fire on their own.

If you want sync that *never* asks you to sign in again, that requires a small server component (a
serverless function holding a refresh token); it's outside the scope of this static app, but it's the
only way around the one-hour browser-token limit.

If a sign-in is ever blocked with **Error 403: access_denied**, your Google Cloud OAuth consent
screen is in *Testing* mode — add your Google address under **Test users** and it'll work. Testing
mode is fine for personal use (no Google verification needed).

## How reminders actually work (important)

A purely client-side PWA **cannot reliably fire notifications when the browser is fully closed** —
there is no server to send a push, and the browser API that once allowed scheduled local
notifications has been removed from Chrome. So:

- **In-app reminders** fire only while the app/tab is open.
- **Google Calendar sync** is what delivers dependable reminders when the app is closed, because
  Google's own infrastructure handles the alert on your phone and desktop.

That is why the recommended setup is both together: log and plan in the app, let Google Calendar do
the reminding.

## Notifications not showing up?

**In-app reminders (while the app is open):**
- Settings → tap **Send a test**. If nothing appears, the OS or browser is blocking notifications —
  allow them for the site, and check the system notification settings for your browser. On Windows,
  also check Focus Assist / Do Not Disturb.
- On iPhone, web notifications only work if you **Add the app to your Home Screen** first (iOS 16.4+);
  they do not work in a Safari tab.
- These only fire while the app is open and not force-closed; phones may suspend timers when the app
  is in the background. For dependable closed-app alerts, use the calendar.

**Google Calendar reminders (the dependable ones):**
The app attaches a popup reminder to every event, but whether your phone actually buzzes depends on
the Google Calendar app, not this app:
- Install the **Google Calendar app**, signed into the same Google account.
- In Google Calendar → Settings → (your account) → make sure **Notifications** are on, and the OS
  has notifications enabled for the Calendar app.
- Set **Remind me before each dose** to something you'll notice (e.g. 10 minutes) rather than "At
  dose time" — a 0-minute reminder is easy to miss. After changing it, re-sync: tap the calendar
  pill / **Connect**, and confirm the re-sync so existing events pick up the new reminder.

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell and markup |
| `styles.css` | Glassmorphic design system |
| `app.js` | State, taper engine, rendering, notifications, Calendar sync |
| `sw.js` | Service worker (offline app shell) |
| `manifest.json` | PWA manifest |
| `icons/` | App icons |

## Notes

- Data is stored in your browser (`localStorage`). Clearing site data or using private mode will
  remove it — use **Export** to back up.
- This is a scheduling aid, not medical advice. Always follow your prescriber's instructions.

## Updates appear automatically

You don't need to clear site data or hard-refresh after deploying. The app is set up so changes
land on their own:

- The service worker is registered with `updateViaCache: 'none'`, so the browser never serves a
  stale copy of `sw.js`.
- Code files are fetched network-first **with the HTTP cache bypassed**, so the worker always gets
  the freshest `app.js`/`styles.css`/`index.html` when online.
- When a new version is detected (on open and whenever the app regains focus), it activates
  immediately and the page **auto-reloads once** to the new version — unless you're mid-edit in the
  add/medicine sheet, in which case it waits until you close it.

The only delay left is GitHub Pages' own propagation (usually a few seconds to a minute after a push)
— that's server-side and outside the app's control. If you ever want to force it during development,
DevTools → Application → Service Workers → "Update on reload" is handy, but day to day you shouldn't
need it.
