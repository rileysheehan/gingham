# Household config

Settings a deployment keeps for one of its households in its own repository, so they change by a reviewed merge and
a deploy, never by editing files on the server. One file per household, named for its id: `<id>.json`.

Only the keys listed in `settings.js` (`OVERLAY`) may be set here. Today that is one:

```json
{"playPage": {"url": "https://example.com/play/", "returnAfterMinutes": 3}}
```

Each value is checked exactly as it would be in the household's `settings.json`; `null` means "none". A key set here
wins: the household's `settings.json` value for it is ignored, taken out of that file the first time the server opens
the household (the server log says so, with the old value), and cannot be changed from Settings. A household without
a file here is unaffected.

Gingham ships this folder with nothing but this README. The files are a deployment's own: keep them in a private
repository if the addresses in them are. `FRAME_HOUSEHOLD_CONFIG` points the server at another folder.
