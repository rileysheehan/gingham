package co.rileysheehan.gingham;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Process;

/**
 * Starts the app again from nothing. Node, once started, cannot be stopped inside its process, so a frame that
 * stops being its own server has to end that process; this runs in a process of its own (see the manifest), ends
 * the main one, opens the frame again and goes away. It is opened while the app is on screen, which newer Androids
 * require of anything that opens an activity.
 */
public final class RestartActivity extends Activity {
    private static final String MAIN_PID = "pid";

    static void restart(Context context) {
        context.startActivity(new Intent(context, RestartActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(MAIN_PID, Process.myPid()));
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        int main = getIntent().getIntExtra(MAIN_PID, -1);
        if (main > 0 && main != Process.myPid()) Process.killProcess(main);   // same app, so this is allowed
        startActivity(new Intent(this, FrameActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        finish();
        Runtime.getRuntime().exit(0);
    }
}
