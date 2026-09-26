# Gingham

**A family wall display.** Gingham turns an Android tablet, or a digital photo frame that runs Android underneath,
into the household's shared screen on the kitchen wall: the calendar, the lists, the weather and the photos, readable
from across the room. It is free, open source, and runs on hardware you choose, with no Gingham cloud: whoever runs a
copy holds that copy's secrets.

[gingham.rileysheehan.co](https://gingham.rileysheehan.co) shows it on the wall of an invented family.

## What is on the screen

- **The left third never changes.** The day, the date and a clock you can read from the stove; the weather now;
  Today and Tomorrow; a countdown ("3 sleeps until June's birthday"); the next sunrise or sunset.
- **The right side is the view you pick.** The calendar, as the week ahead with each day's weather or as an agenda
  of the next four weeks, with this week's days crossed off beside the month; one tab per list with its open count; or
  the photos, full screen.
- **Calendars** by subscription link: Google, Apple, Outlook or any iCalendar feed, with repeating events done
  properly. An event marked private shows only as Busy.
- **Lists** kept by Gingham itself, or in Todoist, Nextcloud, Fastmail and other CalDAV servers, Home Assistant, Google
  Tasks or Microsoft To Do (those two need an app registered for the server). Add at the wall or from a phone; check things off with a moment to undo. A young child's
  list has big rows and a picture on each.
- **Photos** from an iCloud shared album, straight from a phone, or from a folder.
- **Text sized for the room.** Smaller, Standard or Larger, for the rows and the lists; the clock and the layout stay
  as they are.
- **It behaves itself.** Brightness follows sunrise and sunset. After a while it drifts to photos and comes back. After a
  power cut, or with the internet down, it shows the last good screen and says from when.

## What it talks to

Only what you connect, and three things more. The calendars and list services a household adds; **Open-Meteo**, for
the weather and to find the town you type on the setup page; the **iCloud** shared album, if you use one; and, once a
day, **GitHub**, to ask whether a newer Gingham exists. That last one is an unauthenticated request for the latest
release of this repository and sends nothing about your household. Turn it off in the frame's Settings, under Updates
("Check for updates"), or for a whole server with `GINGHAM_UPDATE_CHECK=off`. There is no Gingham account, no
analytics and nothing else.

## Two ways to run it

1. **The tablet is the server.** The Android app carries the server inside it. Nothing else in the house has to be
   switched on, and calendar links and tokens stay on the tablet. On first start it shows a QR code: point a phone
   on the same Wi-Fi at it and you are the household's owner. The address and code are there to type as well.
2. **One server for several households**, run with Docker by someone who likes this sort of thing, for their parents,
   their sister, a friend. Each household is a folder of its own and pairs its own screens.

Setup is always from a phone, at `/setup`: no accounts, no passwords, no email. A screen pairs by a code; a person
gets in by a one-time link, or through a frame the household already has.

### Run a server

```sh
docker run -d --name gingham -p 8080:8080 -v gingham-data:/data \
  -e FRAME_URL=http://192.168.1.20:8080 \
  -e FRAME_MASTER_KEY="$(openssl rand -base64 32)" ghcr.io/rileysheehan/gingham:latest
docker logs gingham        # prints a one-time link: open it on your phone to set up the first household
```

The image is built for Intel and ARM from each release; `docker build -t gingham .` builds the same thing from a checkout.

`FRAME_URL` is the address phones and frames will use to reach it, here this machine on the home network. Keep
`FRAME_MASTER_KEY` somewhere safe and give the same value on every start: it seals each household's calendar
links and tokens on disk. Put the server behind https for use away from home. [docs/HOSTING.md](docs/HOSTING.md)
covers households, pairing, secrets, each list service, Fly.io, and running it from a plain `node server.js`.

### The Android app

`kiosk/` is the app: one activity, a WebView and the server, no libraries. It needs Android 8.0 or later and was built
on a 15.6-inch 1920×1080 photo frame with 1 GB of memory. Signed builds are in this repository's
[releases](https://github.com/rileysheehan/gingham/releases): most frames and cheap tablets want `gingham-32bit.apk`,
and `gingham-either.apk` works on any. To build it yourself, `kiosk/` builds with Gradle (see its build file for the
Node runtime it expects).

### Updates

Gingham is not in an app store, so it tells you itself when there is a newer one: Settings shows the version it is
running and, when a newer release is out, what is new in it. In the Android app, **Install** downloads the release's
file for that tablet, checks it against the release's `SHA256SUMS`, and hands it to Android, which asks you to confirm;
it updates in place and keeps everything. A server says how it is updated instead (pull the new image, or download the
release). Nothing appears on the wall itself, and nothing ever updates on its own.

- **Never forced.** An old frame keeps working. The notice waits in Settings and never grows louder.
- **Forward, never backward.** A new version reads everything an older one wrote and moves it forward if it must;
  going back a version is not supported. Everything from 0.1.0 through 0.1.3 carries over to 0.1.4 as it is.
- **Release notes say what a family gets**, in a few plain sentences, not just a version number
  ([RELEASING.md](RELEASING.md)).

## How it is built

Plain Node with no dependencies and no build step; the pages are plain HTML, CSS and JavaScript, written for the old
WebView cheap frames ship with. `npm test` runs the tests, `npm run check` the syntax check.

- `server.js` serves the frame and the setup pages; `households.js`, `grants.js` and `vault.js` keep households,
  who may do what, and sealed secrets; `updates.js` is the daily update check.
- `integrations.js` gathers calendars and lists; `ics.js`, `caldav.js`, `homeassistant.js`, `googletasks.js` and
  `microsoft.js` speak to each source. Why each signs in the way it does: [docs/SIGN-IN.md](docs/SIGN-IN.md).
- `dist/` is the frame and the phone pages; `site/` is the product page; `kiosk/` the Android app.

## Status

Early, and in daily use on one family's kitchen wall. The current release is 0.1.4. What is coming is in
[docs/ROADMAP.md](docs/ROADMAP.md).

## Licence and security

[AGPL-3.0](LICENSE): use it, change it, run it for anyone; if you run a changed copy for other people, share your
changes. To report a security problem, see [SECURITY.md](SECURITY.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

Gingham is not made by, affiliated with or supported by Todoist, Google, Apple, Microsoft or Home Assistant.
