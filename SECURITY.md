# Security

Gingham holds a household's calendar links and list tokens, and it runs on home networks. Please report a security
problem privately, not in a public issue: use **Report a vulnerability** on this repository's Security tab, which only
the maintainer can read.

Worth knowing when you look:

- A deployment holds its own secrets. There is no Gingham service that sees any household's data.
- Secrets are sealed at rest (AES-256-GCM) when the server has `FRAME_MASTER_KEY`; without it they are plain files
  readable only by the server's user. A tablet that is its own server keeps them in the app's private storage.
- Authority is possession of a long random secret, scoped to one household; only hashes of those are stored.
- Addresses typed on the setup page (calendar links, CalDAV servers, Home Assistant) are fetched over https and only
  from public addresses, unless the deployment opts out for its own home network.
