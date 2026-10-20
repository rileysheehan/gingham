package co.rileysheehan.gingham;

import java.util.Locale;

/**
 * Whether the wall is really on screen, in plain Java so it is tested with a JDK (test/load-java.test.js) rather than
 * on a frame. FrameActivity does the Android half: loading the page, asking it where it is, showing the notice and
 * keeping the wait.
 *
 * A WebView does not say that a load failed in one place. A frame with no clock battery wakes from a power cut years
 * in the past, and a load made in the moment between the Wi-Fi coming up and the network setting the time is refused
 * for its certificate, which a WebView reports apart from every other failure before it ends on Chromium's own blank
 * page. A word about one load can also arrive after the next has begun. An app that takes "finished, and nobody
 * complained" for the wall then sits on that blank page until someone comes to restart it.
 *
 * So nothing counts as the wall until the page on screen says a server answered it. Until then the notice a failure put
 * up stays up, and there is always another try waiting.
 */
final class LoadMath {
    private LoadMath() {}

    /**
     * Whether a page's own address, `location.href` as evaluateJavascript hands it back (a JSON string), is one a
     * server answered. Chromium's error page calls itself chrome-error://chromewebdata/ (data:text/html,chromewebdata
     * in old WebViews) whatever address the WebView gives for it, and a WebView that loaded nothing is at about:blank.
     */
    static boolean served(String href) {
        if (href == null) return false;
        String h = href.trim().toLowerCase(Locale.ROOT);
        if (h.startsWith("\"")) h = h.substring(1);
        return h.startsWith("https://") || h.startsWith("http://");
    }

    /** Whether a page's own address, as served() reads it, is Chromium's error page: never the wall, in any load. */
    static boolean errorPage(String href) {
        if (href == null) return false;
        String h = href.trim().toLowerCase(Locale.ROOT);
        if (h.startsWith("\"")) h = h.substring(1);
        return h.startsWith("chrome-error:") || h.startsWith("data:text/html,chromewebdata");
    }

    /**
     * One wall's loads. FrameActivity tells it what the WebView said and does what it answers:
     * UP, the wall is on screen: take the notice down and stop waiting.
     * WAIT, it is not: put the notice up and try again after the usual wait.
     * AGAIN, it is not, and the wait has already run out: put the notice up and load now.
     * NOTHING, for a word that came too late to mean anything.
     */
    static final class Wall {
        static final int NOTHING = 0, UP = 1, WAIT = 2, AGAIN = 3;

        private int attempt;
        private boolean up, failing, errored, blank, ticked;

        /** A load begins. Its number goes out with the question to the page and comes back with the answer. */
        int begin() { up = false; errored = false; blank = false; ticked = false; return ++attempt; }
        int attempt() { return attempt; }

        /** The wall is on screen. */
        boolean up() { return up; }
        /** A load has failed and the wall has not been seen since: the notice is up. */
        boolean failing() { return failing; }

        /**
         * The WebView said the page itself did not load: no answer, a certificate it would not take, or the server's
         * own 5xx. Whatever finishes after that in the same load is not the wall, even a page a server answered.
         */
        int error() { up = false; failing = true; errored = true; return WAIT; }

        /** A page finished: whether to ask it where it is. After an error there is nothing to learn. */
        boolean ask() { return !errored; }

        /** What the page on screen said of itself during load number `n`. */
        int answer(int n, String href) {
            if (n != attempt || errored) return NOTHING;
            if (served(href)) { up = true; failing = false; blank = false; ticked = false; return UP; }
            up = false; failing = true; blank = true;
            return ticked ? AGAIN : WAIT;
        }

        /**
         * Whether a look at the page could still tell something the WebView has not: the load is in its first wait,
         * nothing has said a word for or against it, and the notice is down.
         */
        boolean peeking() { return !up && !failing && !errored && !blank && !ticked; }

        /**
         * A look at the page every few seconds of a load's first wait (MER-1214). A WebView whose page a service worker
         * keeps can end a failed load on Chromium's error page without a word about it: on the emulators the error page
         * was up at 4 s and the notice not until the wait ran out at 20 s. Only that page counts here. Early in a load
         * the page on screen may still be the one before it, so a look never takes a page for the wall; that is
         * answer()'s, once the WebView says a page finished or the wait runs out. True: the notice goes up now, and the
         * wait already running loads the wall again when it runs out.
         */
        boolean peek(int n, String href) {
            if (n != attempt || !peeking() || !errorPage(href)) return false;
            failing = true; blank = true;
            return true;
        }

        /**
         * The wait ran out and the wall is still not up. True: load it again. False, once in each load and only when
         * nothing has yet said this load failed: ask the page first, because a slow load that has already arrived is
         * not one to start over. If that goes unanswered too, the next time is true.
         */
        boolean tick() {
            if (errored || blank || ticked) return true;
            ticked = true;
            return false;
        }
    }
}
