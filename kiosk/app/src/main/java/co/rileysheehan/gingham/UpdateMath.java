package co.rileysheehan.gingham;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The arithmetic of an update, with nothing of Android in it so a plain JDK can test it (test/update-java.test.js):
 * which versions are newer, which file a build wants, and what a release's SHA256SUMS says each file should hash to.
 * The same version rules as updates.js on the server.
 */
final class UpdateMath {
    private UpdateMath() {}

    static final String REPO = "rileysheehan/gingham";
    static final String EITHER = "gingham-either.apk";

    /** MAJOR.MINOR.PATCH with an optional leading "v" and pre-release; null when it is not one. {major, minor, patch, isPre}. */
    static int[] parse(String version) {
        if (version == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern
            .compile("^v?(0|[1-9]\\d{0,5})\\.(0|[1-9]\\d{0,5})\\.(0|[1-9]\\d{0,5})(-[0-9A-Za-z.-]{1,40})?(\\+[0-9A-Za-z.-]{1,40})?$")
            .matcher(version.trim());
        if (!m.matches()) return null;
        return new int[] {Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)), m.group(4) != null ? 1 : 0};
    }

    /**
     * Whether a release may be offered over what is installed: a stable version, strictly newer. A dev or pre-release
     * build of the same number counts as older than its release; any pre-release candidate is never offered.
     */
    static boolean isNewer(String candidate, String installed) {
        int[] c = parse(candidate), i = parse(installed);
        if (c == null || c[3] == 1) return false;
        if (i == null) return true;
        for (int k = 0; k < 3; k++) if (c[k] != i[k]) return c[k] > i[k];
        return i[3] == 1;   // same number: newer only than a pre-release of it
    }

    /** Exactly the three numbers, for building a release's address: "v0.1.2" and " 0.1.2 " both give "0.1.2". */
    static String plain(String version) {
        int[] v = parse(version);
        return v == null || v[3] == 1 ? null : v[0] + "." + v[1] + "." + v[2];
    }

    /** The file this build wants from a release: the same chip family it was installed as, or the one for either. */
    static String apkFor(String variant) {
        if ("32bit".equals(variant)) return "gingham-32bit.apk";
        if ("64bit".equals(variant)) return "gingham-64bit.apk";
        return EITHER;
    }

    /** Which build is installed, from the native libraries its APK carries: both families is the "either" build. */
    static String variantOf(boolean has32, boolean has64) {
        if (has32 && has64) return "either";
        if (has32) return "32bit";
        if (has64) return "64bit";
        return "either";
    }

    static final String GITHUB = "https://github.com/" + REPO + "/releases/download/";

    /** A release's file, under `base` (GitHub's download address; see RELEASE_BASE in build.gradle). */
    static String releaseFile(String base, String version, String file) {
        return (base.endsWith("/") ? base : base + "/") + "v" + version + "/" + file;
    }

    /**
     * SHA256SUMS as `sha256sum` writes it: "<64 hex>  <file>" per line, or "<64 hex> *<file>" in binary mode. Lines
     * that are not that shape are ignored; a file named twice with different sums is left out, since neither can be
     * trusted.
     */
    static Map<String, String> parseSums(String text) {
        Map<String, String> sums = new HashMap<>();
        java.util.Set<String> conflicted = new java.util.HashSet<>();
        if (text == null) return sums;
        java.util.regex.Pattern line = java.util.regex.Pattern.compile("^([0-9A-Fa-f]{64}) [ *]([^/\\\\\\s][^/\\\\]*)$");
        for (String raw : text.split("\r?\n")) {
            java.util.regex.Matcher m = line.matcher(raw.trim());
            if (!m.matches()) continue;
            String file = m.group(2).trim(), sum = m.group(1).toLowerCase(Locale.ROOT);
            String before = sums.put(file, sum);
            if (before != null && !before.equals(sum)) conflicted.add(file);
        }
        for (String file : conflicted) sums.remove(file);
        return sums;
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
        return out.toString();
    }

    /** Constant-time comparison of two lower-case hex digests. */
    static boolean sameDigest(String expected, String actual) {
        if (expected == null || actual == null || expected.length() != actual.length()) return false;
        int diff = 0;
        for (int i = 0; i < expected.length(); i++) diff |= expected.charAt(i) ^ actual.charAt(i);
        return diff == 0;
    }

    /** Room needed before downloading: the download, Android's copy of it, and the libraries it unpacks at install. */
    static long spaceNeeded(long apkBytes) {
        long size = apkBytes > 0 ? apkBytes : 160L * 1024 * 1024;
        return size * 2 + 150L * 1024 * 1024;
    }
}
