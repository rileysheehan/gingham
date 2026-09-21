package co.rileysheehan.gingham;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Brings the frame up after a reboot, and back after the app itself is updated. Newer Androids only allow this for the launcher, which the frame also is. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        try { context.startActivity(new Intent(context, FrameActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (RuntimeException blockedByAndroid) { /* it starts as the launcher instead */ }
    }
}
