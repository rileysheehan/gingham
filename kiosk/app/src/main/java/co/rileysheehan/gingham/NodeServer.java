package co.rileysheehan.gingham;

import android.content.Context;
import android.content.res.AssetManager;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The frame's own server, running inside the app: the same Node program that runs on a host, on the tablet itself.
 * A household with one frame then needs no other machine, and its calendar links and tokens never leave the wall.
 *
 * Node can be started once per process and never stopped, so this is a one-way door for the life of the process.
 */
final class NodeServer {
    static final int PORT = 4173;
    static final String ADDRESS = "http://127.0.0.1:" + PORT + "/";
    private static final String TAG = "frame-node";
    private static boolean started;
    private static android.net.wifi.WifiManager.MulticastLock multicast;   // held for the life of the process, like Node

    private NodeServer() {}
    private static native int start(String[] arguments);

    static synchronized boolean isStarted() { return started; }

    static synchronized void ensureStarted(final Context context) {
        if (started) return;
        started = true;
        final File server = new File(context.getFilesDir(), "server"), data = new File(context.getFilesDir(), "data");
        new Thread(new Runnable() { @Override public void run() {
            try {
                long began = System.currentTimeMillis();
                unpack(context, server);
                Os.setenv("FRAME_DATA", data.getAbsolutePath(), true);
                Os.setenv("PORT", String.valueOf(PORT), true);
                Os.setenv("HOST", "0.0.0.0", true);              // the phone that sets this up is on the same Wi-Fi
                Os.setenv("FRAME_AUTH", "required", true);        // ...and gets nothing without being let in
                Os.setenv("FRAME_LOCAL_FRAME", "1", true);        // this tablet's own screen is the household's frame
                // One household, on its own Wi-Fi: its Home Assistant, Nextcloud or calendar server at a home address is
                // what it wants, and there is no other household here for such an address to reach into.
                Os.setenv("FRAME_ALLOW_PRIVATE_FEEDS", "1", true);
                String lan = lanAddress(context);
                if (lan != null) Os.setenv("FRAME_URL", "http://" + lan + ":" + PORT, true);   // what a phone on the Wi-Fi types
                Os.setenv("FRAME_MDNS", BuildConfig.NETWORK_NAME, true);   // ...or, more kindly, by name
                listenToTheWholeNetwork(context);
                Os.setenv("HOME", context.getFilesDir().getAbsolutePath(), true);
                Os.setenv("TMPDIR", context.getCacheDir().getAbsolutePath(), true);
                System.loadLibrary("node");
                System.loadLibrary("frame-node");
                Log.i(TAG, "unpacked in " + (System.currentTimeMillis() - began) + " ms; starting Node");
                int code = start(new String[] {"node", new File(server, "server.js").getAbsolutePath()});
                Log.w(TAG, "Node exited with " + code);
            } catch (IOException | ErrnoException | UnsatisfiedLinkError e) {
                Log.e(TAG, "could not start the server", e);
            }
        } }, "frame-node").start();
    }

    /** Android throws away packets addressed to everyone on the Wi-Fi unless an app says it wants them. */
    private static void listenToTheWholeNetwork(Context context) {
        try {
            android.net.wifi.WifiManager wifi = (android.net.wifi.WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi == null) return;
            multicast = wifi.createMulticastLock("frame-name");
            multicast.setReferenceCounted(false);
            multicast.acquire();
        } catch (RuntimeException e) { Log.w(TAG, "no network name: " + e); }
    }

    /** This tablet's address on the Wi-Fi. Asked of Android, because newer Androids do not let Node list interfaces. */
    private static String lanAddress(Context context) {
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            android.net.LinkProperties link = cm == null ? null : cm.getLinkProperties(cm.getActiveNetwork());
            if (link == null) return null;
            for (android.net.LinkAddress a : link.getLinkAddresses()) if (a.getAddress() instanceof java.net.Inet4Address && !a.getAddress().isLoopbackAddress()) return a.getAddress().getHostAddress();
        } catch (RuntimeException ignored) {}
        return null;
    }

    /** True once the server answers on this device. */
    static boolean isUp() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(ADDRESS + "healthz").openConnection();
            c.setConnectTimeout(800); c.setReadTimeout(800);
            try { return c.getResponseCode() == 200; } finally { c.disconnect(); }
        } catch (IOException e) { return false; }
    }

    /** The server's files travel in the APK and are laid out on disk once per app version. */
    private static void unpack(Context context, File target) throws IOException {
        long version;
        try { version = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).lastUpdateTime; } catch (Exception e) { version = 0; }
        File stamp = new File(target, ".unpacked-" + version);
        if (stamp.exists()) return;
        deleteTree(target);
        copyTree(context.getAssets(), "server", target);
        if (!stamp.createNewFile()) throw new IOException("could not mark " + target);
    }
    private static void copyTree(AssetManager assets, String from, File to) throws IOException {
        String[] children = assets.list(from);
        if (children == null || children.length == 0) {           // a file
            File parent = to.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdir " + parent);
            try (InputStream in = assets.open(from); OutputStream out = new FileOutputStream(to)) {
                byte[] buffer = new byte[16384]; int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            }
            return;
        }
        if (!to.isDirectory() && !to.mkdirs()) throw new IOException("mkdir " + to);
        for (String child : children) copyTree(assets, from + "/" + child, new File(to, child));
    }
    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
