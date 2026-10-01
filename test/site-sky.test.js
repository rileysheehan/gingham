// The site's hero is painted with the wall's own sky (site/sky.js, a copy of paintSky's values and rules in dist/app.js).
// The site and the product stay in sync (docs/PLAN.md), so these fail the moment the two copies differ, and check that
// every minute of the site's sky holds its words at the contrast the wall holds its own.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'dist/app.js'), 'utf8');
const site = fs.readFileSync(path.join(root, 'site/sky.js'), 'utf8');
const squash = s => s.replace(/\s+/g, ' ').trim();
const grab = (src, re, what) => { const m = src.match(re); assert.ok(m, what + ' not found'); return m; };
// paintSky's own body, so a second `frames` elsewhere in app.js is never the one compared.
const paintSky = app.slice(app.indexOf('function paintSky()'));

test('The sky\'s colours and inks are the wall\'s', () => {
  const sky = src => new Function('return ' + grab(src, /var SKY = (\{[\s\S]*?\n\s*\});/, 'SKY')[1])();
  assert.deepEqual(sky(site), sky(app));
  const inks = src => grab(src, /var INK_NAVY = (\[[^\]]*\]), INK_CREAM = (\[[^\]]*\]), SKY_CONTRAST = ([\d.]+);/, 'INK_NAVY, INK_CREAM, SKY_CONTRAST').slice(1).map(v => JSON.parse(v));
  assert.deepEqual(inks(site), inks(app));
});

test('The sky is blended, flipped and held by the wall\'s rules', () => {
  const frames = src => squash(grab(src, /var frames = \[[\s\S]*?\];/, 'frames')[0]);
  assert.equal(frames(site), frames(paintSky));
  const flip = /var light = luminance\(mix\(top, bottom, 0\.5\)\) > ([\d.]+);/;
  assert.equal(grab(site, flip, 'the ink flip')[1], grab(paintSky, flip, 'the ink flip')[1]);
  const hold = /function hold\(c\) \{.*\}/;
  assert.equal(grab(site, hold, 'hold')[0], grab(paintSky, hold, 'hold')[0]);
  for (const fn of [/function mix\(a, b, t\) \{.*\}/, /function luminance\(c\) \{[\s\S]*?\n {2}\}/, /function contrast\(a, b\) \{.*\}/])
    assert.equal(squash(grab(site, fn, fn.source)[0]), squash(grab(app, fn, fn.source)[0]));
  // With no forecast, the wall's day: sunrise 7 AM, sunset 7 PM (app.js sunTimes).
  assert.match(app, /return \{ rise: base \+ 7 \* 3600000, set: base \+ 19 \* 3600000 \};/);
  assert.match(site, /var sun = \{ rise: base \+ 7 \* 3600000, set: base \+ 19 \* 3600000 \};/);
});

// Runs site/sky.js as the page would, at a given minute and scheme, and returns what it painted.
function paint(minute, dark) {
  const props = {}, meta = [];
  const RealDate = Date, at = new RealDate(2026, 9, 8, 0, minute).getTime();
  class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(at); } static now() { return at; } }
  const document = {
    documentElement: { style: { setProperty: (k, v) => { props[k] = v; } }, classList: { toggle() {} } },
    getElementById: () => null, querySelectorAll: () => meta, addEventListener() {}
  };
  vm.runInNewContext(site, { window: { matchMedia: () => ({ matches: dark }) }, document, Date: FixedDate, setTimeout() {} });
  const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);
  return { top: rgb(props['--hero-top']), bottom: rgb(props['--hero-bottom']), ink: rgb(props['--hero-ink']) };
}
const lum = c => { const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

test('Every minute of the day, the hero\'s words hold on its sky', () => {
  for (const dark of [false, true]) for (let m = 0; m < 1440; m++) {
    const s = paint(m, dark), when = (dark ? 'dark ' : 'light ') + Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
    if (dark) assert.deepEqual(s.ink, [253, 246, 238], 'the dark scheme is a night sky with cream ink at ' + when);
    // The wall's 8:1, at every point of the gradient. Each end is held to 8:1 and then rounded to whole RGB values, as
    // the wall rounds its own, which can cost a few hundredths (7.97:1 at worst).
    for (let i = 0; i <= 10; i++) {
      const bg = mix(s.top, s.bottom, i / 10);
      assert.ok(ratio(s.ink, bg) >= 7.95, 'the ink at ' + when);
      // Secondary words are the ink at 85%: AA for body text, 4.5:1, at every point of the sky.
      assert.ok(ratio(mix(bg, s.ink, 0.85), bg) >= 4.5, 'the secondary ink at ' + when);
    }
  }
});
