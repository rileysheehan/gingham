# Hosting the frame away from home

The frame's server is one small Node program with timers and a disk. At home it runs on any computer that stays on, or on the tablet itself. Hosted, the same
program runs in a container on Fly.io (about $2 a month: a 256 MB always-on machine and a small volume), so a frame
in someone else's house needs nothing but Wi-Fi. Decided 2026-09-20 after weighing Vercel (free plan runs scheduled
jobs once a day and caps storage at 1 GB), Cloudflare Workers (free, but a rewrite shaped by its limits) and Fly
(the code as it is). It is a plain container, so moving hosts later is a deploy file, not a rewrite.

## How it fits together

- **Households.** Everything a family owns lives in `data/households/<id>/`: `sources.json` (name, time zone, place,
  calendars, lists, people, album link), `credentials.json` (their Google and Todoist authorizations),
  `settings.json`, `photos/`, `cache/`. One deployment serves several households and nothing is shared between them.
- **Who may do what (`grants.js`).** There are no accounts, passwords or email addresses. Authority is possession
  of a long random secret with a scope: a *frame* reads one household, checks off its tasks and changes its display
  settings; an *owner* also configures that household and pairs its frames; an *admin* looks after the deployment.
  Only SHA-256 hashes are stored (`data/grants.json`), each secret has a label and a last-seen time, and revoking
  one cuts that device off at once.
- **How a screen gets its secret.** An unpaired screen shows a six-character code (no 0/O/1/I/L). Someone with
  authority approves it (`admin.js frame pair <code> <household> "Kitchen"`, later the household's setup page), and
  the screen's next poll is answered, once, with a cookie that is `HttpOnly`, `Secure` and `SameSite=Strict`, so
  the page itself never sees the secret. Codes last ten minutes and tries are rationed per address. This is the
  "sign in on your TV" flow, and it lives in the web page, so it works in any kiosk browser: the device only needs
  the server's address.
- **How a person gets theirs.** A one-time link, good for three days, redeemed by a deliberate press rather than by
  opening it, because message apps fetch every address they see to draw a preview and would spend it. Redeeming
  mints a secret for that one device; the link is dead afterwards. (Built and tested in `grants.js`; the pages that
  use it come with the household setup page.)
- **The fallback.** `admin.js frame add` still makes a standing `/?k=<secret>` link, for setting a frame up over ADB.
- **Two modes.** `FRAME_AUTH=required` (the container's default): an unpaired browser gets the page shell and
  nothing else: every `/api/` and `/photos/` answer is 401. Unset (one household, at home): an unpaired browser on the
  home network gets the default household, as before, and photos keep their address allowlist.
- **Time.** A container runs in UTC and households live in different zones, so nothing uses the machine's clock zone:
  days begin at midnight in `sources.json → timezone` (`zone.js`), weather is for `place`, and the page learns its
  zone from `/api/household`.
- **What is never served.** Only files directly in `dist/` and `dist/fonts/`. `data/` has no route at all.

## The setup page

`/setup`, made for a phone. Whoever looks after a household does it here, with no shell: its name and place (typed
as a town, which also sets the time zone), calendars by subscription link, lists (made right here with no other account, or chosen from Todoist), the
photo album, pairing and removing frames, and adding another device that may make changes. A calendar link is read
before it is kept, so a wrong one is caught on the spot ("Added. 5 events in the next two months."). Nothing secret
is ever sent back to the page: it learns that a calendar has a link, not what the link is.

Getting in is one-time; being in is not. The device that opens a link stays an owner and can come back to `/setup`
whenever something needs changing. What a link cannot cover is a new phone or a cleared browser, and for that
**the frame vouches for the phone**: on the frame, Settings, "Manage from a phone", the household PIN; the frame
shows a QR code of the setup link with a one-time code in it; scanning it, or typing the code at `/setup`, makes that phone an owner. Being in the home plus the PIN is the proof. The
PIN is four to eight digits, set on the setup page, stored stretched (scrypt) inside the sealed credentials, and
five wrong tries shut that door for fifteen minutes, doubling each time. With no PIN set the door does not exist,
because otherwise anyone left alone with the frame could add their own phone and read the calendar from anywhere.
Every device that can make changes is listed on the page, with when it was last seen and a Remove button.

People first arrive by a one-time link: `node admin.js owner link <household> "<whose>" --url https://<host>`. Opening it
shows a button; pressing the button makes that device an owner and spends the link. From then on an owner adds
their own further devices from the page. `setup.js` is the API (every route needs an owner of that household, or an
admin naming one), `dist/setup.html`, `setup.css` and `setup-page.js` are the page.

## Secrets

Each household's `credentials.json` holds what it has been trusted with: calendar links, a Todoist token, a Google
authorization. With `FRAME_MASTER_KEY` set (32 random bytes, base64: `openssl rand -base64 32`), that file is
AES-256-GCM ciphertext sealed to the household's own id (`vault.js`). A copy of the volume, a snapshot or a backup
then gives away none of those secrets, and one household's file cannot be opened from another's folder. The key lives
in the host's secret store (`fly secrets`), not on the volume. A plain file is sealed the first time the server sees it.
Without a key the file stays plain JSON, mode 600, which is fine for one household on a machine at home.

Only the secrets are sealed. What the frame shows is not: each household's names, lists, photos and the last
calendar and list answers it kept for outages are ordinary files on the volume, so treat a backup of it as private.

## Behind a proxy

Pairing codes and the setup and sign-in endpoints are rationed per address, so the server has to know whose address
a request is. On Fly it reads `Fly-Client-IP`, which Fly's proxy sets itself. Behind another proxy (Caddy, nginx, a
Cloudflare tunnel), set `FRAME_TRUST_PROXY=1` and it takes the last address in `X-Forwarded-For`, the one your proxy
added; make sure the proxy is the only way in, since anyone who can reach the server directly could claim any address.
Without either, every request counts as coming from the proxy, which is safe but shares one ration among everyone.

Secrets go in and do not come out. `admin.js secret set` takes the value from standard input, so it never lands in
shell history or a process list, and `admin.js secret names` lists what is set, never the values. **Keep a copy of
the master key somewhere safe.** Without it the sealed files cannot be opened, and every household would have to
give its links and tokens again. What this does not protect against: someone who gets code running inside the
server has the key and the files both. It is a defence for data at rest, not a substitute for the rest.

## Calendars

A household's calendars are listed in its `sources.json`, and each is one of two kinds.

**By subscription link (preferred).** No sign-in, no Google project, works the same for Google, iCloud and Outlook:

```
sources.json      "calendars": [{"id": "theo", "name": "Theo", "color": "#38977b", "source": "ics"}]
credentials.json  "ics": {"theo": "webcal://p01-caldav.icloud.com/published/2/…"}
```

The link is a secret (anyone holding it can read the calendar), which is why it lives in `credentials.json` and
never in the answer the page gets. Where people find theirs: in Google Calendar, a calendar's settings, "Secret
address in iCal format"; in Apple's Calendar, share the calendar as a Public Calendar and copy the link; in Outlook,
Settings, Shared calendars, Publish. `ics.js` reads the feed, including repeating events, exceptions and daylight
saving; `safe-fetch.js` fetches it, and refuses anything that is not a public https address, so a link cannot be
used to make the server look around its own network (`FRAME_ALLOW_PRIVATE_FEEDS=1` for a calendar server at home).
Feeds are asked for at most every five minutes.

**By Google sign-in.** `{"id": "<google calendar id>", …}` with no `source`, using the `google` block in
`credentials.json`. This is how the first household began. To move one over, check the link against the sign-in
first: `node scripts/compare-calendar.js <household> <google calendar id> <secret address>`.

A calendar that cannot be read does not blank the others: it falls back to what it last gave and is named in the
answer's `problems`.

## Looking after it

```
node admin.js households
node admin.js household add <id>                 # then fill in its sources.json and credentials.json
node admin.js frame pair <code> <household> "Kitchen"   # approve the code a screen is showing
node admin.js frames                             # everything holding a secret, and when it was last seen
node admin.js frame revoke <id>
node admin.js frame add <household> "Kitchen" --url https://<host>   # standing link, for ADB setups
```

On Fly the same commands run through `fly ssh console -C "su-exec node node admin.js …"`.

## First run

Started with no households, the server makes one called `home` and prints a one-time setup link where whoever
started it will see it (the terminal, `docker logs`, `fly logs`). Open it on the phone or computer the household
will be managed from; everything else happens on the setup page, including pairing the frame. Set `FRAME_URL` to
the server's public address so the printed link is right.

## First deploy (once)

1. Make a Fly.io account and add a card. Install the CLI and sign in: `curl -L https://fly.io/install.sh | sh`,
   then `~/.fly/bin/fly auth login`.
2. Pick a unique app name in `fly.toml`, then `fly launch --copy-config --no-deploy` (creates the app and the
   `frame_data` volume in `dfw`) and `fly deploy`.
3. Put the first household on the volume: `fly ssh console`, `su-exec node node admin.js household add home`,
   or copy `sources.json` and `credentials.json` from an earlier machine with `fly ssh sftp shell`. Photos need no copying:
   the album mirrors itself from iCloud within a few minutes.
4. `fly certs add frame.example.com`, and in your DNS point that name at the app as a CNAME (with Cloudflare, DNS only, not proxied), so Fly can validate and renew the certificate itself.
5. Open the server's address on the device, read the code it shows, and approve it with `admin.js frame pair`.
6. For push-to-deploy: `fly tokens create deploy`, saved as a repository secret, and a workflow that runs the tests
   and then `flyctl deploy --remote-only` on pushes to `main`.


## Photos from a phone

`/photos`, for whoever may change a household. Pictures chosen there are redrawn in the browser before they are sent
(at most 2560 pixels on the long side, always a JPEG), which also leaves behind everything a camera writes into a
file, where it was taken included; only the day it was taken travels with it. They are kept in the household's
`uploads/` folder, up to 1,500 of them at 8 MB each, and show on the frame with the shared album's photos if there
is one. A paired frame can show them and cannot add or remove them.

## A folder of photos

For pictures that already live on a disk. Each household has a folder of its own, `data/households/<id>/folder/`;
put JPEGs in it (subfolders are fine) or mount a directory onto it, read-only:

    docker run … -v /volume1/photos/family:/data/households/home/folder:ro …

It is read every fifteen minutes. There is no setting for it and no path to type, on purpose: a path typed on a
web page would let whoever looks after one household read another's files. Pictures are shown as they are, so ones
over 6000 pixels on a side or 12 MB, and anything that is not a JPEG (HEIC included), are passed over; the setup
page says how many, and sending those from a phone on `/photos` makes them fit.

## Nextcloud, Fastmail and other CalDAV servers

Task lists on any CalDAV server connect on the setup page with the server's address, a username and an app password.
The server must be on the public internet with https, as for calendar links; someone running Gingham for one
household at home, with a Nextcloud or Synology on the same network, sets `FRAME_ALLOW_PRIVATE_FEEDS=1`.

## Home Assistant

Home Assistant's to-do lists (and every list app it is connected to) connect on the setup page with its address and a
long-lived access token from its profile page. A tablet that is its own server reaches Home Assistant on the home
network; the app allows home addresses there. A hosted server needs Home Assistant's remote address over https, such as
a Nabu Casa address. Home Assistant 2024.8 or later is needed to read lists from outside it (UNVERIFIED version: the
REST API's `?return_response`).

## Google Tasks

Offered only where the deployment has its own Google app and a public https address, because Google allows Tasks no
sign-in by code and returns only to a registered https address. Once, for the whole deployment (every household on it
then just signs in):

1. In the Google Cloud console, make or pick a project and enable the **Google Tasks API**.
2. In the OAuth consent screen, choose External, name the app, and add the scopes `.../auth/tasks`, `openid` and
   `email`. Publish it to production. Unverified, people see "Google hasn't verified this app" and the app is capped at
   100 users; left in Testing, Google expires every sign-in after seven days. Verification (free for these scopes)
   removes both.
3. Create an OAuth client of type **Web application** with the redirect URI `https://<your address>/oauth/google`.
4. Give the server `FRAME_URL=https://<your address>` and the client's ID and secret as `GINGHAM_GOOGLE_CLIENT_ID` and
   `GINGHAM_GOOGLE_CLIENT_SECRET`. On Fly, `FRAME_URL` goes in `fly.toml` and the two others through
   `fly secrets import` from standard input, never on a command line.

Disconnecting on the setup page revokes the token at Google too.

## Microsoft To Do

Offered on the setup page once Gingham's Microsoft app ID is in `microsoft.js`, or when `GINGHAM_MS_CLIENT_ID` names
your own registration (a public client with "Allow public client flows" on, supporting personal and work accounts,
delegated `Tasks.ReadWrite`). Sign-in is by a code entered at Microsoft, so a server needs no public address for it.
A work account may need its administrator's consent. Why it works this way: `docs/SIGN-IN.md`.

## The admin page

`/admin`, for whoever runs the server and looks after more than one household on it. It lists the households, makes
a new one from its name, and shows the one-time link to send to whoever will look after it; from there that person
does everything on `/setup`. The way in is a link from a shell, once per device:

    node admin.js admin link "My laptop" --url https://<host>

On Fly: `fly ssh console -C "su-exec node node admin.js admin link Laptop --url https://<host>"`. An admin belongs
to no household and can open any household's setup page. Someone who runs one household for themselves never needs
this page: the first-run link makes them that household's owner.

## A name on the home network

A tablet that is its own server answers to a name as well as to its numbers: `FRAME_MDNS=gingham` makes the server
answer "who is gingham.local?" on the Wi-Fi (multicast DNS, in `mdns.js`, no dependencies). Apple phones, computers and
Android 12 and later look names up this way by themselves; older Androids do not, so the welcome screen shows the
name with the numbers under it. If the name is taken (a second frame in the house) it becomes `gingham-2`. The app
sets this itself. It stays off everywhere else: multicast does not reach inside a container, and on a shared
machine the name belongs to the machine.

## Updates

Once shortly after it starts and then once a day, the server asks GitHub's public API for the latest release of
rileysheehan/gingham (`updates.js`). The request is unauthenticated and carries nothing about any household: a fixed
`User-Agent: Gingham` and, after the first answer, GitHub's ETag, so an unchanged answer is an empty 304. It gives up
after ten seconds, waits out a rate limit, and a failure is one line in the log and another try the next day. It is
never on a request's path, and the wall never waits on it.

- **Off for a whole server:** `GINGHAM_UPDATE_CHECK=off`. The frame's Settings then shows the check as off and cannot
  change it. With one household on the server, its frame may turn the check on or off itself (Settings → Updates);
  with several, only the variable decides. The choice, the last answer and its ETag live in `data/updates.json`.
- **What a frame shows:** the version this server runs, and, when a newer release exists, its notes and how this copy
  is updated, from `GINGHAM_FORM`: `container` (set by the image) says to pull `ghcr.io/rileysheehan/gingham:latest`
  and start it again; a plain `node server.js` says to download the release. The Android app installs its own update
  from Settings when someone taps Install. Nothing on the wall, and nothing ever updates on its own.
- **The version** is `package.json`'s, in every form: the server, the image and the app's `versionName` all read it,
  and a release tag that disagrees stops the release build.
- **Updating** never goes backward: a newer server reads an older one's `data/` as it is and migrates forward if it
  must. Keep a copy of `data/` before a major version, and do not point an older version at data a newer one wrote.

## Known gaps

- **Photos that are not JPEG.** On a Mac the server converts them with macOS's `sips`; the container skips them with a log
  line. iCloud keeps a JPEG of nearly every photo, so this is rare.

