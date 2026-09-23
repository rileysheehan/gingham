package co.rileysheehan.gingham;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/**
 * Android's answers about an update being installed. The first is nearly always "the person must confirm", with the
 * confirm screen to show; the last is success (by which time this process has usually been ended and BootReceiver
 * brings the new version up), a cancel, or a failure in Android's words.
 */
public class UpdateReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!UpdateInstaller.ACTION_STATUS.equals(intent.getAction())) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        UpdateInstaller updates = UpdateInstaller.get(context);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @SuppressWarnings("deprecation") Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm == null) { updates.installFinished(PackageInstaller.STATUS_FAILURE, "Android did not ask to confirm"); return; }
            updates.confirming();
            try { context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
            catch (RuntimeException e) { updates.installFinished(PackageInstaller.STATUS_FAILURE, "Android's installer could not be opened"); }
            return;
        }
        updates.installFinished(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
    }
}
