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

To remove the calendar events later, delete the medicine in the app while connected, or remove the
events directly in Google Calendar.

## How reminders actually work (important)

A purely client-side PWA **cannot reliably fire notifications when the browser is fully closed** —
there is no server to send a push, and the browser API that once allowed scheduled local
notifications has been removed from Chrome. So:

- **In-app reminders** fire only while the app/tab is open.
- **Google Calendar sync** is what delivers dependable reminders when the app is closed, because
  Google's own infrastructure handles the alert on your phone and desktop.

That is why the recommended setup is both together: log and plan in the app, let Google Calendar do
the reminding.

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
