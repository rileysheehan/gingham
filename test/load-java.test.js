// The Android app's rules for loading the wall (kiosk/.../LoadMath.java), compiled and run with a plain JDK: which page
// counts as the wall, and what the app does about every word a WebView gives it, in the order a WebView gives them. The
// first cases are a night a frame spent on a blank page: nothing in them may end without the wall up or a try waiting.
//
// Skipped, saying so, where there is no JDK (javac on PATH or under JAVA_HOME). `npm test` runs it wherever there is one.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

const SOURCE = path.join(__dirname, '..', 'kiosk', 'app', 'src', 'main', 'java', 'co', 'rileysheehan', 'gingham', 'LoadMath.java');
function jdk() {
  for (const bin of [process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin'), ''].filter(b => b !== undefined && b !== null)) {
    const javac = bin ? path.join(bin, 'javac') : 'javac', java = bin ? path.join(bin, 'java') : 'java';
    const probe = spawnSync(javac, ['-version'], {encoding: 'utf8'});
    if (probe.status === 0) return {javac, java};
  }
  return null;
}
const tools = jdk();

// Reads one case per line, "<kind>\t<a>", and prints one answer per line in the same order.
const DRIVER = `package co.rileysheehan.gingham;
import java.nio.file.*;
public class LoadDriver {
  public static void main(String[] a) throws Exception {
    for (String line : new String(Files.readAllBytes(Paths.get(a[0])), "UTF-8").split("\\n", -1)) {
      if (line.isEmpty()) continue;
      String[] c = line.split("\\t", -1);
      String href = c[1].equals("<none>") ? null : c[1];
      System.out.println(c[0].equals("served") ? LoadMath.served(href) + "," + LoadMath.errorPage(href) : wall(c[1]));
    }
  }
  static final String[] NEXT = {"nothing", "up", "wait", "again"};
  // One wall, played through "b" (a load begins), "e" (the WebView reports an error), "f" (a page finished: ask it?),
  // "a n href" (the page's answer in load n, "." for the load under way), "p n href" (what a look during the first
  // wait saw: "show" the notice or "-"), "k" (is a look still worth making?), "t" (the wait ran out) and "s" (where
  // are we?), answering everything but the "b"s in order.
  static String wall(String script) {
    LoadMath.Wall w = new LoadMath.Wall();
    StringBuilder out = new StringBuilder();
    for (String op : script.split(";")) {
      String[] p = op.trim().split(" ");
      String said = null;
      switch (p[0]) {
        case "b": w.begin(); break;
        case "e": said = NEXT[w.error()]; break;
        case "f": said = w.ask() ? "ask" : "skip"; break;
        case "a": said = NEXT[w.answer(p[1].equals(".") ? w.attempt() : Integer.parseInt(p[1]), p[2])]; break;
        case "p": said = w.peek(p[1].equals(".") ? w.attempt() : Integer.parseInt(p[1]), p[2]) ? "show" : "-"; break;
        case "k": said = w.peeking() ? "look" : "no"; break;
        case "t": said = w.tick() ? "load" : "ask"; break;
        case "s": said = w.up() ? "up" : w.failing() ? "failing" : "-"; break;
      }
      if (said != null) out.append(out.length() > 0 ? "," : "").append(said);
    }
    return out.toString();
  }
}
`;

// location.href as evaluateJavascript hands it back: JSON, so a string comes in its quotes.
const WALL = '"https://frame.example.com/"', ERROR_PAGE = '"chrome-error://chromewebdata/"';
// Each with whether a server answered it, and whether it is Chromium's error page (which a look in a load's first wait
// may act on; about:blank and the rest may be the page before the load and are left to the wait).
const SERVED = [[WALL, true], ['"http://gingham.local/"', true], ['"http://127.0.0.1:18080/"', true], ['"HTTPS://FRAME.EXAMPLE.COM/"', true],
  [' "https://frame.example.com/?k=secret" ', true], ['https://frame.example.com/', true],
  [ERROR_PAGE, false, true], ['"data:text/html,chromewebdata"', false, true], ['"about:blank"', false], ['"file:///android_asset/index.html"', false],
  ['"javascript:void(0)"', false], ['"httpx://frame.example.com/"', false], ['"chrome-error://chromewebdata/?https://frame.example.com/"', false, true],
  ['"CHROME-ERROR://chromewebdata/"', false, true], ['null', false], ['""', false], ['', false], ['<none>', false]];
const WALLS = [
  [`b; f; a . ${WALL}; s`, 'ask,up,up', 'a load that works: the page says where it is, and the wall is up'],
  // No Wi-Fi yet; then Wi-Fi with the clock still years back, so the certificate is refused; then the clock is right.
  [`b; e; f; s; t; b; e; f; s; t; b; f; a . ${WALL}; s`, 'wait,skip,failing,load,wait,skip,failing,load,ask,up,up',
    'a power cut: each failure waits and loads again, and the notice stays until the wall is seen'],
  [`b; e; b; f; a . ${ERROR_PAGE}; s; t; b; f; a . ${WALL}; s`, 'wait,ask,wait,failing,load,ask,up,up',
    'the same night when the WebView reports no error for the second load: Chromium’s error page finishing is not the wall'],
  [`b; e; b; f; a . ${ERROR_PAGE}; f; a . ${WALL}; s`, 'wait,ask,wait,ask,up,up', 'the first load’s error page finishes after the second has begun: the second can still be the wall'],
  [`b; f; b; a 1 ${WALL}; s`, 'ask,nothing,-', 'an answer to a question asked of an earlier load says nothing about this one'],
  [`b; e; b; s; f; s`, 'wait,failing,ask,failing', 'trying again does not take the notice down: only the wall does'],
  [`b; e; f; a . ${WALL}; s; t`, 'wait,skip,nothing,failing,load', 'the server’s own 5xx page is at the wall’s address and is still not the wall'],
  [`b; t; a . "about:blank"; s`, 'ask,again,failing', 'a load the WebView never says a word about: asked when the wait runs out, and loaded again at once'],
  [`b; t; t`, 'ask,load', 'and if the page does not answer either, the next wait loads it again'],
  [`b; t; a . ${WALL}; s`, 'ask,up,up', 'a slow load that has arrived by the time the wait runs out is not started over'],
  [`b; e; b; t; a . ${WALL}; s`, 'wait,ask,up,up', 'nor is a slow one that follows a failure'],
  [`b; f; a . ${WALL}; e; s; t`, 'ask,up,wait,failing,load', 'the wall reloads itself after an update and that fails: back to trying'],
  [`b; f; a . ${WALL}; f; a . ${ERROR_PAGE}; s; t`, 'ask,up,ask,wait,failing,load', 'the same, when the WebView reports no error for it'],
  [`b; f; a . ${WALL}; f; a . ${WALL}; s`, 'ask,up,ask,up,up', 'and when the wall’s own reload works, nothing changes'],
  // A look every few seconds of the first wait (MER-1214): the page a service worker keeps can end on the error page
  // with no word from the WebView, which left it blank until the wait ran out.
  [`b; k; p . "about:blank"; k; p . ${ERROR_PAGE}; s; k; t`, 'look,-,look,show,failing,no,load',
    'the error page seen early puts the notice up, and the wait loads the wall again when it runs out'],
  [`b; p . ${WALL}; s; k; f; a . ${WALL}; s`, '-,-,look,ask,up,up', 'a look never takes a page for the wall: that is the WebView’s word and the wait’s'],
  [`b; p . ${ERROR_PAGE}; f; a . ${WALL}; s; k`, 'show,ask,up,up,no', 'a look at the page before this load that was the error page: the wall still takes the notice down'],
  [`b; f; a . ${WALL}; k; p . ${ERROR_PAGE}; s`, 'ask,up,no,-,up', 'once the wall is up, no look'],
  [`b; e; k; p . ${ERROR_PAGE}; t`, 'wait,no,-,load', 'nor once the WebView has said the load failed: the notice is up already'],
  [`b; t; k; p . ${ERROR_PAGE}; s`, 'ask,no,-,-', 'nor after the first wait: it is answer()’s again'],
  [`b; b; p 1 ${ERROR_PAGE}; s; k`, '-,-,look', 'a look made for an earlier load says nothing of this one']
];

test('The app’s rules for loading the wall: which page counts, and that a failed load always leaves the notice up and another try waiting', {skip: !tools && 'no JDK here (set JAVA_HOME or put javac on PATH)'}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-java-'));
  try {
    const pkg = path.join(dir, 'src', 'co', 'rileysheehan', 'gingham');
    fs.mkdirSync(pkg, {recursive: true});
    fs.copyFileSync(SOURCE, path.join(pkg, 'LoadMath.java'));
    fs.writeFileSync(path.join(pkg, 'LoadDriver.java'), DRIVER);
    execFileSync(tools.javac, ['-d', path.join(dir, 'classes'), path.join(pkg, 'LoadMath.java'), path.join(pkg, 'LoadDriver.java')], {stdio: 'pipe'});
    fs.writeFileSync(path.join(dir, 'cases'), [...SERVED.map(([href]) => 'served\t' + href), ...WALLS.map(([script]) => 'wall\t' + script)].join('\n') + '\n');
    const out = execFileSync(tools.java, ['-cp', path.join(dir, 'classes'), 'co.rileysheehan.gingham.LoadDriver', path.join(dir, 'cases')], {encoding: 'utf8'}).split('\n');
    let i = 0;
    for (const [href, served, error = false] of SERVED) assert.equal(out[i++], served + ',' + error, 'served, error page: ' + JSON.stringify(href));
    for (const [script, said, why] of WALLS) assert.equal(out[i++], said, why + ' (' + script + ')');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// The activity's half, which no JDK can run: read from the source, so the mistake that left a frame dark cannot come back
// quietly. The wall is asked for by its address and never reloaded, and a refused certificate is counted as a failure.
test('The app loads the wall by its address, never reload(), and counts a refused certificate as a failed load', () => {
  const activity = fs.readFileSync(path.join(path.dirname(SOURCE), 'FrameActivity.java'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  assert.doesNotMatch(activity, /\.reload\s*\(/, 'reload() asks again for whatever is on screen, which may be Chromium’s error page');
  assert.match(activity, /web\.loadUrl\(wallUrl\)/);
  const ssl = activity.match(/onReceivedSslError\([^)]*\)\s*\{([^}]*)\}/);
  assert.ok(ssl, 'the wall’s WebView listens for certificate errors');
  assert.match(ssl[1], /\.cancel\(\)/);
  assert.doesNotMatch(activity, /\.proceed\s*\(/, 'a certificate error is never waved through');
  assert.match(ssl[1], /load\.error\(\)/);
});
