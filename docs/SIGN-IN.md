# Signing in to other list apps

A proposal, 2026-09-21. **Status:** Microsoft To Do is built (`microsoft.js`) and waits only for Gingham's app
registration (decision 2, tabled). CalDAV tasks (`caldav.js`), Home Assistant's to-do lists (`homeassistant.js`) and Google Tasks (`googletasks.js`)
are built; Google Tasks waits for a Google app registered for the deployment. TickTick is not built.

Gingham should reach the list, calendar and photo apps a family already uses, not only Todoist. The code is ready: a
list says which source it comes from (`source` in `integrations.js`), so each new app is one adapter. The hard part is
signing in without a Gingham cloud. Nobody may run a shared service that holds a family's tokens or trades codes for
them. Whoever runs a deployment holds its secrets, and a tablet that is its own server has no public web address.

## Three ways in

Each provider's rules decide which one it gets. The provider facts are from each provider's own documentation,
checked 2026-09-21; the unconfirmed ones are marked.

**1. Paste a token or an app password.** This is what Todoist does today, and it needs nothing from anyone. It suits
people who can find a token in a settings page.
- **Todoist:** a personal API token. It is still supported and does not expire.
- **CalDAV tasks** (Nextcloud, Fastmail, Synology, mailbox.org): the server address, a username and an app password.
- **Home Assistant:** its address and a long-lived access token. Its to-do lists are read and written through
  `todo.get_items`, `add_item`, `update_item` and `remove_item`. One adapter reaches every list app Home Assistant
  already connects to: Google Tasks, Todoist, CalDAV, its local lists, and others through community integrations. The
  server must be able to reach Home Assistant. That is always true for a tablet on the home Wi-Fi, but a hosted
  server needs Home Assistant's remote address.

**2. A code on the phone (device code).** For **Microsoft To Do**, and later Outlook calendars.
- The setup page shows "open microsoft.com/devicelogin and enter K7WPX4R2". The person signs in to Microsoft on their
  own phone, and the server polls until Microsoft hands it a token. Nothing redirects anywhere, so it works the same
  on a tablet with no web address as on a hosted server.
- It uses one app registration with no secret (a "public client"). Its ID can ship in Gingham's code and serve every
  copy: a public client's ID is not a secret. Microsoft's CLI tools and rclone work this way, though no Microsoft page
  explicitly blesses one shared ID. A self-hoster can supply their own ID instead.
- Microsoft permits the device-code flow for personal accounts (outlook.com, hotmail) with the `Tasks.ReadWrite` and
  `offline_access` permissions. Personal accounts consent for themselves.
- A work or school account may need its administrator's consent, and some organisations block device-code sign-in
  outright.
- Refresh tokens last 90 days from last use and are replaced on every use. Gingham refreshes about once a minute, so
  the new token must be saved each time.
- Until Riley verifies as a publisher, Microsoft's consent screen shows the app as "Unverified". Verification is
  optional and free with a Microsoft Partner Network ID.

**3. The deployment's own OAuth app.** For **Google Tasks**, and **TickTick**.
- **Why Google can't use a code:** its device-code flow is allowed only for basic profile, a narrow slice of Drive, and
  YouTube. Tasks and Calendar are not on the list. So Google needs the ordinary redirect sign-in.
- **Where Google can redirect:** only to a public HTTPS address or `localhost`. It cannot redirect to a raw IP address
  or `gingham.local`, and it blocks sign-in inside an embedded WebView.
- **Why each deployment registers its own:** a shared Google app would need its client secret kept somewhere private,
  which means a cloud. So whoever runs a server registers a Google app once.
- **Registering it:** the scope is `tasks`. Google says `tasks` is "sensitive", not "restricted" (confirm in the
  Console when registering). Sensitive scopes need no paid security assessment. The redirect is the server's own
  address, for example `https://frame.example.com/oauth/google`.
- **Google's limits:**
  - Left in "Testing", Google expires its refresh tokens after 7 days.
  - Set to "In production" but unverified, people see "Google hasn't verified this app", and the app is capped at 100
    users. Both are fine for one deployment's households.
  - Verification removes both, needs a privacy policy and a homepage (the microsite can carry them), and is free for
    sensitive scopes.
- **What this means in practice:** on Riley's server, one Google app covers every friends-and-family household, and
  none of them registers anything.
- **TickTick** works the same way, with its own client secret and no personal token.

**A tablet that is its own server and wants Google** needs one more thing: a redirect page with a public address.
- **How it works.** The page would be a static file, for example `gingham.rileysheehan.co/oauth`. It does nothing but
  send the browser on to the tablet's local address, carried in `state`, with the one-time code. Home Assistant does
  this with my.home-assistant.io.
- **Why it's safe.**
  - The page holds no secret and stores nothing.
  - The code is useless without the deployment's client secret and its PKCE verifier. Both stay on the tablet, and the
    code expires in minutes.
  - The page would forward only to home-network addresses, so it cannot become an open redirect.
- **Who depends on it.** Anyone can host their own copy anywhere, so no one depends on Riley's.
- **Proposal: defer it.** A tablet on its own can use Microsoft, CalDAV, Home Assistant or Todoist meanwhile.

**Not reachable:**
- **Apple Reminders:** no web API. It left CalDAV with "upgraded Reminders", and Apple's own framework runs only on an
  Apple device.
- **Google Keep:** its API is for Workspace administrators only.
- **AnyList, OurGroceries, Bring! and Cozi:** no official API, only reverse-engineered ones, which we will not build
  on. Home Assistant may reach some of them; to be checked per app.
- **iCloud calendars** are still reachable by CalDAV with an app-specific password. That also opens the road to
  editing events.

## What every connection does

- **One contract per adapter.** Each adapter does four things: its lists (for the setup page to choose from), their
  items (title, section, due, assignee, repeating), add, and close.
- **Secrets stay sealed.** Tokens are kept in the household's vault like the Todoist token: sealed where there is a
  master key, write-only, never sent back to a page. Access tokens live only in memory. A rotated refresh token is
  saved before the old one is dropped.
- **Only a looker-after can connect.** Only an owner or admin can start a connection, from the setup page, and it is
  rationed like the other setup actions. A device code is only ever started by someone already signed in to setup,
  since the flow is a known phishing route.
- **Ask for as little as possible.** Microsoft gets `openid profile offline_access Tasks.ReadWrite`; the profile part
  only lets setup show which account is connected. Google gets `tasks` and nothing else.
- **Failure is said plainly.** When a provider stops accepting the token, the setup page says "Microsoft needs you to
  sign in again". The frame keeps the list as last seen and says it can't refresh it, as it already does for Todoist.
- **Disconnect means both ends.** Disconnect deletes the tokens here and links to the provider's page for removing the
  app's access there.

## Proposed order

1. **Microsoft To Do.** It is the most-used, needs nothing but a sign-in, and works the same everywhere.
2. **CalDAV tasks.** A pasted app password; Nextcloud and Fastmail households.
3. **Home Assistant to-do.** One adapter, many list apps, for homes that run it.
4. **Google Tasks.** It works on any deployment with a public address, including Riley's. A tablet on its own waits
   for the redirect page.
5. **TickTick**, then calendars through the same doors: Outlook by device code, iCloud by CalDAV.

This replaces the earlier plan, which put Google Tasks first before its sign-in rules were known.

## Decisions for Riley

1. **Approve the three ways in and the order**, Microsoft first.
2. **Register Gingham's Microsoft app** under your Microsoft account.
   - It is free and takes about ten minutes; I'll walk you through it.
   - Its ID becomes the one that ships.
   - Whether a personal account can still register apps without a free Entra directory is unconfirmed; we'll find out
     when registering.
   - Publisher verification, which removes "Unverified", can come later.
3. **Google on your server:** register a Google app for Riley's deployment and set it to "In production", accepting
   the warning screen for now. Or wait on Google until the rest ships, and pursue verification with the microsite's
   privacy page.
4. **The redirect page** for Google on a tablet alone: defer it (recommended), or plan it with the microsite's hosting.

## Still to confirm while building

- Google's classification of `tasks`, in the Cloud Console.
- Microsoft's current rule for registering apps with a personal account.
- The Home Assistant version that added `return_response` to its REST API, and which list apps it reaches in core.
