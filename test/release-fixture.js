// What GitHub's API answers for a release, trimmed to the fields updates.js reads: for tests, and for design review
// (`FRAME_FIXTURE=stress FRAME_FIXTURE_UPDATE=available`), where the server must never ask GitHub itself.
const release = (version, body) => ({
  tag_name: 'v' + version, name: 'v' + version, draft: false, prerelease: false,
  html_url: 'https://github.com/rileysheehan/gingham/releases/tag/v' + version,
  published_at: '2026-10-06T15:00:00Z',
  body
});

module.exports = {
  release,
  // A newer release, written the way RELEASING.md asks: what a family gets, first, as a few bullets.
  newer: release('0.1.2', [
    '- Lists can be reordered from the wall: hold an item, then drag it.',
    '- Countdowns name the day of the week once they are a week away.',
    '- The frame starts about twice as fast on tablets with 1 GB of memory.',
    '- A calendar that asks for a password again says so in Settings, with what to do.',
    '- Fixes: a chore checked off twice in a row no longer comes back.',
    '',
    '**Which file:** most frames and cheap tablets want gingham-32bit.apk; gingham-either.apk works on any.'
  ].join('\n')),
  // The same version as the one running.
  same: version => release(version, '- Settings shows which Gingham is running, and says when a newer one is out.')
};
