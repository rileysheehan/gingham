// The Android app's update arithmetic (kiosk/.../UpdateMath.java), compiled and run with a plain JDK: which versions it
// will install over, which file a build wants, how it reads a release's SHA256SUMS, and that a download is accepted
// only when its SHA-256 matches. The same cases as the server's (updates.test.js) where the two overlap.
//
// Skipped, saying so, where there is no JDK (javac on PATH or under JAVA_HOME). GitHub's Ubuntu runners have one.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync, spawnSync} = require('node:child_process');

const SOURCE = path.join(__dirname, '..', 'kiosk', 'app', 'src', 'main', 'java', 'co', 'rileysheehan', 'gingham', 'UpdateMath.java');
function jdk() {
  for (const bin of [process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin'), ''].filter(b => b !== undefined && b !== null)) {
    const javac = bin ? path.join(bin, 'javac') : 'javac', java = bin ? path.join(bin, 'java') : 'java';
    const probe = spawnSync(javac, ['-version'], {encoding: 'utf8'});
    if (probe.status === 0) return {javac, java};
  }
  return null;
}
const tools = jdk();

// Each line the driver prints is one case: "<name>\t<result>".
const DRIVER = `package co.rileysheehan.gingham;
public class Driver {
  static void out(String name, Object value) { System.out.println(name + "\\t" + value); }
  public static void main(String[] a) throws Exception {
    String[][] newer = {{"v0.1.2","0.1.1"},{"0.2.0","0.1.10"},{"0.1.1","0.1.1"},{"0.1.0","0.1.1"},{"0.2.0-beta.1","0.1.1"},{"0.1.1","0.1.1-dev.3"},{"0.1.1","0.1.1-dev"},{"garbage","0.1.1"},{"0.1.2","garbage"},{"01.2.3","0.1.1"}};
    for (String[] p : newer) out("newer " + p[0] + " " + p[1], UpdateMath.isNewer(p[0], p[1]));
    out("plain v0.1.2", UpdateMath.plain("v0.1.2"));
    out("plain beta", UpdateMath.plain("0.1.2-beta.1"));
    for (String v : new String[] {"32bit","64bit","either","other"}) out("apk " + v, UpdateMath.apkFor(v));
    out("variant 32+64", UpdateMath.variantOf(true, true)); out("variant 32", UpdateMath.variantOf(true, false));
    out("variant 64", UpdateMath.variantOf(false, true)); out("variant none", UpdateMath.variantOf(false, false));
    out("url", UpdateMath.releaseFile(UpdateMath.GITHUB, "0.1.2", "SHA256SUMS"));
    java.util.Map<String,String> sums = UpdateMath.parseSums(new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(a[0])), "UTF-8"));
    out("sums", new java.util.TreeMap<>(sums));
    byte[] apk = java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(a[1]));
    String actual = UpdateMath.hex(java.security.MessageDigest.getInstance("SHA-256").digest(apk));
    out("hash", actual);
    out("verify good", UpdateMath.sameDigest(sums.get("gingham-32bit.apk"), actual));
    out("verify other", UpdateMath.sameDigest(sums.get("gingham-64bit.apk"), actual));
    out("verify missing", UpdateMath.sameDigest(sums.get("gingham-99bit.apk"), actual));
    out("space 80MB", UpdateMath.spaceNeeded(80L * 1024 * 1024) / (1024 * 1024));
  }
}
`;

test('The app’s update arithmetic: versions, files, SHA256SUMS and the checksum', {skip: !tools && 'no JDK here (set JAVA_HOME or put javac on PATH)'}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-java-'));
  try {
    const pkg = path.join(dir, 'src', 'co', 'rileysheehan', 'gingham');
    fs.mkdirSync(pkg, {recursive: true});
    fs.copyFileSync(SOURCE, path.join(pkg, 'UpdateMath.java'));
    fs.writeFileSync(path.join(pkg, 'Driver.java'), DRIVER);
    execFileSync(tools.javac, ['-d', path.join(dir, 'classes'), path.join(pkg, 'UpdateMath.java'), path.join(pkg, 'Driver.java')], {stdio: 'pipe'});

    // A release's files and its SHA256SUMS as `sha256sum *.apk > SHA256SUMS` writes it, plus the lines a parser must
    // not trust: a sum given twice two ways, a path, junk, a binary-mode line, Windows line ends.
    const apk = crypto.randomBytes(200000), other = crypto.randomBytes(1000);
    const sha = b => crypto.createHash('sha256').update(b).digest('hex');
    fs.writeFileSync(path.join(dir, 'gingham-32bit.apk'), apk);
    const sums = [sha(apk) + '  gingham-32bit.apk', sha(other).toUpperCase() + ' *gingham-64bit.apk', sha(other) + '  gingham-either.apk', 'a'.repeat(64) + '  gingham-either.apk',
      'not a line at all', 'b'.repeat(64) + '  ../../evil.apk', 'c'.repeat(63) + '  short.apk', ''].join('\r\n');
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums);

    const out = Object.fromEntries(execFileSync(tools.java, ['-cp', path.join(dir, 'classes'), 'co.rileysheehan.gingham.Driver', path.join(dir, 'SHA256SUMS'), path.join(dir, 'gingham-32bit.apk')], {encoding: 'utf8'})
      .trim().split('\n').map(line => line.split('\t')));
    assert.deepEqual(['v0.1.2 0.1.1', '0.2.0 0.1.10', '0.1.1 0.1.1', '0.1.0 0.1.1', '0.2.0-beta.1 0.1.1', '0.1.1 0.1.1-dev.3', '0.1.1 0.1.1-dev', 'garbage 0.1.1', '0.1.2 garbage', '01.2.3 0.1.1'].map(k => out['newer ' + k]),
      ['true', 'true', 'false', 'false', 'false', 'true', 'true', 'false', 'true', 'false'], 'newer, stable, never backward, never a pre-release');
    assert.equal(out['plain v0.1.2'], '0.1.2');
    assert.equal(out['plain beta'], 'null', 'a pre-release is never a file to fetch');
    assert.deepEqual(['32bit', '64bit', 'either', 'other'].map(v => out['apk ' + v]), ['gingham-32bit.apk', 'gingham-64bit.apk', 'gingham-either.apk', 'gingham-either.apk']);
    assert.deepEqual(['32+64', '32', '64', 'none'].map(v => out['variant ' + v]), ['either', '32bit', '64bit', 'either']);
    assert.equal(out.url, 'https://github.com/rileysheehan/gingham/releases/download/v0.1.2/SHA256SUMS');
    assert.equal(out.sums, '{gingham-32bit.apk=' + sha(apk) + ', gingham-64bit.apk=' + sha(other) + '}',
      'binary mode and upper case read; a file named twice with two sums, a path, and junk are dropped');
    assert.equal(out.hash, sha(apk), 'Java and Node agree on the digest');
    assert.equal(out['verify good'], 'true');
    assert.equal(out['verify other'], 'false', 'a different file is refused');
    assert.equal(out['verify missing'], 'false', 'a file SHA256SUMS does not name is refused');
    assert.equal(out['space 80MB'], '310');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
