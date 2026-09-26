// The Android app's play-page rules (kiosk/.../PlayMath.java), compiled and run with a plain JDK: which addresses it
// will open, how long it waits before bringing the wall back, and where the play page may go once it is up. The
// addresses are the server's own cases (settings.test.js), and the app must agree with the server on every one.
//
// Skipped, saying so, where there is no JDK (javac on PATH or under JAVA_HOME). The kiosk workflow runs it.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
const {cleanPlayPage} = require('../settings');

const SOURCE = path.join(__dirname, '..', 'kiosk', 'app', 'src', 'main', 'java', 'co', 'rileysheehan', 'gingham', 'PlayMath.java');
function jdk() {
  for (const bin of [process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin'), ''].filter(b => b !== undefined && b !== null)) {
    const javac = bin ? path.join(bin, 'javac') : 'javac', java = bin ? path.join(bin, 'java') : 'java';
    const probe = spawnSync(javac, ['-version'], {encoding: 'utf8'});
    if (probe.status === 0) return {javac, java};
  }
  return null;
}
const tools = jdk();

// Reads one case per line, "<kind>\t<a>[\t<b>]", and prints one answer per line in the same order.
const DRIVER = `package co.rileysheehan.gingham;
import java.nio.file.*;
public class PlayDriver {
  public static void main(String[] a) throws Exception {
    for (String line : new String(Files.readAllBytes(Paths.get(a[0])), "UTF-8").split("\\n", -1)) {
      if (line.isEmpty()) continue;
      String[] c = line.split("\\t", -1);
      Object out;
      switch (c[0]) {
        case "url": out = PlayMath.validUrl(c[1]); break;
        case "minutes": out = PlayMath.returnMinutes(c[1].equals("null") ? null : c[1].startsWith("s:") ? (Object) c[1].substring(2)
          : c[1].contains(".") ? (Object) Double.valueOf(c[1]) : c[1].startsWith("L") ? (Object) Long.valueOf(c[1].substring(1)) : (Object) Integer.valueOf(c[1])); break;
        case "same": out = PlayMath.sameOrigin(c[1], c[2]); break;
        case "settings": out = PlayMath.settingsUrl(c[1]); break;
        default: out = "?";
      }
      System.out.println(String.valueOf(out));
    }
  }
}
`;

const URLS = ['https://example.com/play/', ' https://example.com ', 'https://example.com:8443/a?b=c#d', 'HTTPS://example.com/',
  'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>hi</b>', 'http://example.com/', 'file:///etc/passwd',
  'ftp://example.com/', 'intent://example.com#Intent;end', 'https://user:pass@example.com/', 'https://user@example.com/', '//example.com/',
  'example.com', '', 'https://', 'https://example.com/' + 'x'.repeat(2000)];
const MINUTES = [['null', 3], ['0', 3], ['31', 3], ['2.5', 3], ['s:5', 3], ['-1', 3], ['1', 1], ['30', 30], ['L10', 10], ['5', 5]];
const SAME = [
  ['https://example.com/play/', 'https://example.com/other/page?x=1', true],
  ['https://example.com/play/', 'https://EXAMPLE.com:443/', true],
  ['https://example.com/play/', 'http://example.com/play/', false],
  ['https://example.com/play/', 'https://www.example.com/', false],
  ['https://example.com/play/', 'https://example.com.evil.test/', false],
  ['https://example.com/play/', 'https://example.com:8443/', false],
  ['https://example.com/play/', 'https://evil.test/?https://example.com/', false],
  ['https://example.com/play/', 'intent://example.com/#Intent;scheme=https;end', false],
  ['https://example.com/play/', 'tel:5551234', false],
  ['https://example.com/play/', 'javascript:alert(1)', false],
  ['https://example.com/play/', 'about:blank', false],
  ['not a url', 'not a url', false]
];
const SETTINGS = [['http://127.0.0.1:18080/', 'http://127.0.0.1:18080/api/settings'], ['https://frame.example.com/?k=secret', 'https://frame.example.com/api/settings'],
  ['http://frame.local/', 'http://frame.local/api/settings'], ['https://frame.example.com:8443/', 'https://frame.example.com:8443/api/settings'], ['gingham://pair', 'null']];

test('The app’s play-page rules: the addresses it opens, the minutes it waits, and where the page may go', {skip: !tools && 'no JDK here (set JAVA_HOME or put javac on PATH)'}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-java-'));
  try {
    const pkg = path.join(dir, 'src', 'co', 'rileysheehan', 'gingham');
    fs.mkdirSync(pkg, {recursive: true});
    fs.copyFileSync(SOURCE, path.join(pkg, 'PlayMath.java'));
    fs.writeFileSync(path.join(pkg, 'PlayDriver.java'), DRIVER);
    execFileSync(tools.javac, ['-d', path.join(dir, 'classes'), path.join(pkg, 'PlayMath.java'), path.join(pkg, 'PlayDriver.java')], {stdio: 'pipe'});
    const lines = [...URLS.map(u => 'url\t' + u), ...MINUTES.map(([m]) => 'minutes\t' + m), ...SAME.map(([a, b]) => 'same\t' + a + '\t' + b), ...SETTINGS.map(([w]) => 'settings\t' + w)];
    fs.writeFileSync(path.join(dir, 'cases'), lines.join('\n') + '\n');
    const out = execFileSync(tools.java, ['-cp', path.join(dir, 'classes'), 'co.rileysheehan.gingham.PlayDriver', path.join(dir, 'cases')], {encoding: 'utf8'}).split('\n');
    let i = 0;
    for (const url of URLS) {
      const java = out[i++], server = cleanPlayPage({url});
      assert.equal(java !== 'null', server !== null, 'the app and the server agree about ' + JSON.stringify(url));
    }
    for (const [given, kept] of MINUTES) assert.equal(out[i++], String(kept), 'minutes ' + given);
    for (const [a, b, same] of SAME) assert.equal(out[i++], String(same), a + ' vs ' + b);
    for (const [wall, asked] of SETTINGS) assert.equal(out[i++], asked, wall);

    // Every address the server tidies and serves is one the app accepts unchanged.
    const served = URLS.map(url => cleanPlayPage({url})).filter(Boolean).map(p => p.url);
    fs.writeFileSync(path.join(dir, 'cases'), served.map(u => 'url\t' + u).join('\n') + '\n');
    const again = execFileSync(tools.java, ['-cp', path.join(dir, 'classes'), 'co.rileysheehan.gingham.PlayDriver', path.join(dir, 'cases')], {encoding: 'utf8'}).trim().split('\n');
    assert.deepEqual(again, served);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
