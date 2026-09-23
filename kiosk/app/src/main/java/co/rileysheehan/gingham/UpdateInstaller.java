package co.rileysheehan.gingham;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.StatFs;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Installing a newer Gingham, when someone taps Install in Settings. Never on its own, never silently.
 *
 * The page names only a version. Everything else is decided here: the file is this build's own chip family from that
 * version's GitHub release (or the one for either), its SHA-256 must match the release's SHA256SUMS before anything is
 * done with it, and then Android's own installer is handed the file and asks the person to confirm. Every release is
 * signed with the same key, so Android updates in place and keeps the household's data; a file signed by anyone else
 * would be refused by Android, whatever the checksum said. No device-admin or accessibility powers are involved.
 *
 * One install at a time, in this process. The page asks for the state (status()) about once a second while one runs.
 */
final class UpdateInstaller {
    private static final String TAG = "gingham-update";
    static final String ACTION_STATUS = "co.rileysheehan.gingham.INSTALL_STATUS";
    private static UpdateInstaller instance;

    static synchronized UpdateInstaller get(Context context) {
        if (instance == null) instance = new UpdateInstaller(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final File dir;
    private String variant;
    // What the page shows. idle | permission | downloading | verifying | confirm | failed
    private String state = "idle", version = "", reason = "", detail = "";
    private long done, total;
    private boolean waitingForPermission;
    private volatile boolean cancelled;
    private Thread worker;

    private UpdateInstaller(Context context) {
        this.context = context;
        this.dir = new File(context.getCacheDir(), "update");
        cleanUp();   // whatever an earlier run left behind: the new version is installed, or it was not
    }

    // ---------------------------------------------------------------- what the page sees

    /** {"version":"0.1.1","variant":"32bit","installs":true}: this app, and whether it can install an update itself. */
    String describe() {
        try {
            return new JSONObject().put("version", BuildConfig.VERSION_NAME).put("variant", variant()).put("installs", true).toString();
        } catch (JSONException e) { return "{}"; }
    }

    synchronized String status() {
        try {
            JSONObject out = new JSONObject().put("state", state).put("version", version);
            if (!reason.isEmpty()) out.put("reason", reason);
            if (!detail.isEmpty()) out.put("detail", detail);
            if ("downloading".equals(state)) out.put("done", done).put("total", total);
            if ("space".equals(reason)) out.put("needMb", Math.max(1, UpdateMath.spaceNeeded(total) / (1024 * 1024)));
            return out.toString();
        } catch (JSONException e) { return "{\"state\":\"idle\"}"; }
    }

    // ---------------------------------------------------------------- what the page asks

    /** Install `requested`, a version the server says is out. Ignored unless it is newer than this app. */
    synchronized void install(String requested) {
        final String target = UpdateMath.plain(requested);
        if (target == null || !UpdateMath.isNewer(target, BuildConfig.VERSION_NAME)) { fail(requested == null ? "" : requested, "invalid", ""); return; }
        if (worker != null && worker.isAlive()) return;
        version = target;
        // Android asks once whether this app may install apps. Ask before the download, so nobody waits for one only
        // to be stopped at the end.
        if (!mayInstall()) { set("permission", "", ""); waitingForPermission = true; return; }
        waitingForPermission = false;
        start(target);
    }

    /** Android's own page for "Install unknown apps", for this app only. */
    void openPermission() {
        if (Build.VERSION.SDK_INT < 26) return;
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { context.startActivity(intent); }
        catch (RuntimeException e) {
            // Some cut-down Androids have no such page; the general one is the next best thing.
            try { context.startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (RuntimeException ignored) {}
        }
    }

    /** The frame came back to the front, perhaps from Android's permission page: carry on if it was granted. */
    synchronized void resumed() {
        if (waitingForPermission && "permission".equals(state) && mayInstall()) { waitingForPermission = false; start(version); }
        else if ("confirm".equals(state) && worker == null) {
            // The confirm dialog was left without an answer reaching us (some Androids send none on Back): say so.
            fail(version, "cancelled", "");
        }
    }

    synchronized void cancel() {
        cancelled = true;
        waitingForPermission = false;
        if (!"confirm".equals(state)) set("idle", "", "");
    }

    /** Called by UpdateReceiver with Android's answer about the install. */
    synchronized void installFinished(int status, String message) {
        switch (status) {
            case PackageInstaller.STATUS_SUCCESS: set("idle", "", ""); cleanUp(); break;   // this process is usually ended first
            case PackageInstaller.STATUS_FAILURE_ABORTED: fail(version, "cancelled", ""); break;
            case PackageInstaller.STATUS_FAILURE_STORAGE: fail(version, "space", ""); break;
            default: fail(version, "install", message == null ? "" : message);
        }
        if (status != PackageInstaller.STATUS_SUCCESS) cleanUp();
    }

    /** Android is showing its confirm dialog. */
    synchronized void confirming() { set("confirm", "", ""); }

    // ---------------------------------------------------------------- the work

    private boolean mayInstall() { return Build.VERSION.SDK_INT < 26 || context.getPackageManager().canRequestPackageInstalls(); }

    private void start(final String target) {
        cancelled = false;
        done = 0; total = 0;
        set("downloading", "", "");
        worker = new Thread(new Runnable() { @Override public void run() { work(target); } }, "gingham-update");
        worker.start();
    }

    private void work(String target) {
        File apk = null;
        try {
            cleanUp();
            if (!dir.isDirectory() && !dir.mkdirs()) throw new Failure("space", "");
            // The checksums first: small, and without them nothing downloaded could be trusted.
            Map<String, String> sums = UpdateMath.parseSums(fetchText(UpdateMath.releaseFile(BuildConfig.RELEASE_BASE, target, "SHA256SUMS")));
            String file = UpdateMath.apkFor(variant());
            if (!sums.containsKey(file)) file = UpdateMath.EITHER;
            String expected = sums.get(file);
            if (expected == null) throw new Failure("missing", "");
            apk = new File(dir, "gingham-" + target + ".apk");
            String actual = download(UpdateMath.releaseFile(BuildConfig.RELEASE_BASE, target, file), apk);
            synchronized (this) { if (cancelled) return; set("verifying", "", ""); }
            if (!UpdateMath.sameDigest(expected, actual)) {
                Log.w(TAG, file + " hashed to " + actual + ", SHA256SUMS says " + expected);
                throw new Failure("checksum", "");
            }
            synchronized (this) { if (cancelled) return; }
            handToAndroid(apk);
            synchronized (this) { worker = null; if (!"failed".equals(state)) set("confirm", "", ""); }
        } catch (Failure f) {
            synchronized (this) { worker = null; if (!cancelled) fail(target, f.reason, f.getMessage()); }
            cleanUp();
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "update failed", e);
            String why = String.valueOf(e.getMessage());
            synchronized (this) { worker = null; if (!cancelled) fail(target, why.contains("ENOSPC") || why.contains("No space") ? "space" : "network", ""); }
            cleanUp();
        } finally {
            synchronized (this) { if (cancelled) { worker = null; set("idle", "", ""); } }
        }
    }

    private static final class Failure extends IOException {
        final String reason;
        Failure(String reason, String detail) { super(detail); this.reason = reason; }
    }

    private HttpURLConnection open(String address) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);   // github.com hands release files to its storage host, https to https
        c.setRequestProperty("User-Agent", "Gingham");
        int code = c.getResponseCode();
        if (code == 404) { c.disconnect(); throw new Failure("missing", ""); }
        if (code != 200) { c.disconnect(); throw new IOException("HTTP " + code); }
        // Never downgraded to plain http on the way (only an emulator test build's own base is http).
        if (!c.getURL().getProtocol().equals(Uri.parse(BuildConfig.RELEASE_BASE).getScheme())) { c.disconnect(); throw new IOException("scheme changed"); }
        return c;
    }

    private String fetchText(String address) throws IOException {
        HttpURLConnection c = open(address);
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192]; int n;
            while ((n = in.read(buffer)) > 0) { out.write(buffer, 0, n); if (out.size() > 64 * 1024) throw new IOException("SHA256SUMS too large"); }
            return out.toString("UTF-8");
        } finally { c.disconnect(); }
    }

    /** Downloads to `to`, hashing on the way, and returns the SHA-256 in hex. */
    private String download(String address, File to) throws IOException {
        HttpURLConnection c = open(address);
        try {
            long length = c.getContentLengthLong();
            synchronized (this) { total = Math.max(0, length); }
            long free = new StatFs(dir.getAbsolutePath()).getAvailableBytes();
            if (free < UpdateMath.spaceNeeded(length)) throw new Failure("space", "");
            MessageDigest sha;
            try { sha = MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException e) { throw new IOException(e); }
            File part = new File(to.getPath() + ".part");
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                byte[] buffer = new byte[65536]; int n; long got = 0;
                while ((n = in.read(buffer)) > 0) {
                    if (cancelled) throw new InterruptedIOException("cancelled");
                    out.write(buffer, 0, n); sha.update(buffer, 0, n); got += n;
                    synchronized (this) { done = got; }
                }
                if (length > 0 && got != length) throw new IOException("short download");
            }
            if (!part.renameTo(to)) throw new IOException("rename");
            return UpdateMath.hex(sha.digest());
        } finally { c.disconnect(); }
    }

    /** Android's own installer takes it from here, and asks the person to confirm. */
    private void handToAndroid(File apk) throws IOException {
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName());
        params.setSize(apk.length());
        // Android 12 and later could let an app update itself without asking; this one always asks.
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
        int id = installer.createSession(params);
        PackageInstaller.Session session = installer.openSession(id);
        try {
            try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("gingham.apk", 0, apk.length())) {
                byte[] buffer = new byte[65536]; int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
                session.fsync(out);
            }
            Intent status = new Intent(context, UpdateReceiver.class).setAction(ACTION_STATUS);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);   // Android fills in the result
            session.commit(PendingIntent.getBroadcast(context, id, status, flags).getIntentSender());
        } catch (IOException | RuntimeException e) {
            session.abandon();
            throw e;
        } finally {
            session.close();
        }
    }

    // ---------------------------------------------------------------- small things

    /** Which chip family this build is: read from the libraries in the installed APK, once. */
    synchronized String variant() {
        if (variant != null) return variant;
        boolean has32 = false, has64 = false;
        try (ZipFile zip = new ZipFile(context.getApplicationInfo().sourceDir)) {
            java.util.Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements() && !(has32 && has64)) {
                String name = entries.nextElement().getName();
                if (name.startsWith("lib/armeabi-v7a/")) has32 = true;
                else if (name.startsWith("lib/arm64-v8a/")) has64 = true;
            }
        } catch (IOException | RuntimeException e) { Log.w(TAG, "could not read the installed APK", e); }
        variant = UpdateMath.variantOf(has32, has64);
        return variant;
    }

    private synchronized void set(String state, String reason, String detail) { this.state = state; this.reason = reason; this.detail = detail; }
    private synchronized void fail(String version, String reason, String detail) { this.version = version; set("failed", reason, detail == null ? "" : detail); }

    private void cleanUp() {
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }
}
