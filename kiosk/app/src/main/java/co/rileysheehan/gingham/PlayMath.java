package co.rileysheehan.gingham;

import java.net.URI;
import java.util.Locale;

/**
 * The play page's rules (DESIGN.md → "A play page, for one household"), in plain Java so they are tested with a JDK
 * (test/play-java.test.js) rather than on a frame. FrameActivity does the Android half: asking the household's server
 * for the address, showing it, and coming back to the wall.
 *
 * The server already drops anything but a plain https address (settings.js), and the app checks again rather than
 * trust whatever answered: the address is what it will show a child full screen.
 */
final class PlayMath {
    private PlayMath() {}

    static final int RETURN_MIN = 1, RETURN_MAX = 30, RETURN_DEFAULT = 3;

    /** The address to open, tidied, or null unless it is https with a host and no name or password in it. */
    static String validUrl(String url) {
        if (url == null) return null;
        url = url.trim();
        if (url.isEmpty() || url.length() > 2000) return null;
        URI uri;
        try { uri = new URI(url); } catch (Exception e) { return null; }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null) return null;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;
        return uri.toString();
    }

    /** Minutes of no touch before the wall comes back: a whole number from 1 to 30, three otherwise. */
    static int returnMinutes(Object value) {
        if (value instanceof Integer || value instanceof Long) {
            long m = ((Number) value).longValue();
            if (m >= RETURN_MIN && m <= RETURN_MAX) return (int) m;
        }
        return RETURN_DEFAULT;
    }

    /**
     * Whether `other` is on the same origin as `home`: scheme, host and port, the port read as the scheme's own when
     * it is not written. While the play page is up, this is the only place the app will go; anything else, another
     * site, a link out of it, a tel: or an intent:, is refused.
     */
    static boolean sameOrigin(String home, String other) {
        String a = origin(home), b = origin(other);
        return a != null && a.equals(b);
    }

    /** scheme://host:port, lower-cased, with the port always written; null for anything that is not http or https. */
    static String origin(String url) {
        if (url == null) return null;
        URI uri;
        try { uri = new URI(url.trim()); } catch (Exception e) { return null; }
        String scheme = uri.getScheme() == null ? null : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (host == null || host.isEmpty() || !("https".equals(scheme) || "http".equals(scheme))) return null;
        int port = uri.getPort() != -1 ? uri.getPort() : "https".equals(scheme) ? 443 : 80;
        return scheme + "://" + host.toLowerCase(Locale.ROOT) + ":" + port;
    }

    /** Where to ask the wall's own server for the household's settings: the wall's origin, /api/settings. */
    static String settingsUrl(String wall) {
        String o = origin(wall);
        if (o == null) return null;
        if (o.startsWith("https://") && o.endsWith(":443")) o = o.substring(0, o.length() - 4);
        else if (o.startsWith("http://") && o.endsWith(":80")) o = o.substring(0, o.length() - 3);
        return o + "/api/settings";
    }
}
