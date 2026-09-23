# Releasing Gingham

1. Bump `version` in `package.json` (semantic: `0.1.2` for fixes and small things, `0.2.0` for something new). The
   release workflow refuses a tag that disagrees with it, because a frame compares the two.
2. Write `releases/v<version>.md`: what a family gets, as a few bullet points, the most useful first. A frame shows
   the first four under "What's new" in Settings, so each bullet is one plain sentence about the wall, the phone pages
   or the app, not a commit title: "Lists can be reordered from the wall", not "Refactor list ordering". Say when
   something needs doing by hand. After the bullets, a short paragraph if anything else must be said.
3. Tag and push: `git tag v<version> && git push origin v<version>`. The workflow builds the three signed APKs,
   `SHA256SUMS` and the container image, and publishes the release with those notes (or, with no notes file,
   GitHub's list of changes).

## What a release promises

- **Nothing is forced.** A frame says a newer version exists, in Settings and nowhere else, and updates only when
  someone taps Install (the app) or pulls the new image (a server). An old frame keeps working as it is.
- **Data moves forward, never backward.** A new version reads everything an older one wrote. Formats only gain
  fields with defaults; when one ever has to change shape, the new server migrates it on start and keeps what it
  replaced. Going back to an older version is not supported.
- **Same key, every time.** Every APK is signed with the one release key, so Android updates in place and keeps the
  household's data. Losing that key would mean every family reinstalling by hand; keep it safe.
