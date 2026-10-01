# Installing on a photo frame

Gingham is an Android app that is not in an app store, so it is installed from a file: an APK from the
[latest release](https://github.com/rileysheehan/gingham/releases/latest). Most frames and cheap tablets want
`gingham-32bit.apk`; `gingham-either.apk` runs on any Android 8.0 or later.

## A tablet, or a frame with a browser

Open https://gingham.rileysheehan.co on it and tap **Download the app**. When the download finishes, open it. Android
asks once whether the browser may install apps; allow it, then tap Install. That is all: Gingham starts, shows a QR
code, and the rest is set up from a phone.

## A frame without a browser

Many photo frames (Frameo ones among them) have no browser and no app store. They can still install an APK from a
computer, over a USB cable, with Android's own tool for it, ADB.

**What you need**

- A computer with Android's platform tools, which include `adb`:
  [download them from Google](https://developer.android.com/tools/releases/platform-tools) and unzip them anywhere.
- A USB cable with **USB-A** on the computer's end (an adapter is fine). On the frame this was built on, a USB-C to
  USB-C cable never connected.
- `gingham-32bit.apk` from the latest release, saved next to `adb`.

**Steps**

1. **Turn on ADB on the frame.** Each frame maker hides it somewhere different. For a Frameo frame, follow
   [Frameo's own instructions](https://support.frameo.com/hc/en-us/articles/6126183308434--How-to-Enable-ADB-on-Your-Frame).
   Otherwise, look for *Developer options* and *USB debugging* in the frame's Android settings.
2. **Put the frame's USB port in device mode, if it needs it.** On Frameo frames that is Settings → Manage photos →
   Transfer from computer. It switches itself off again when the frame restarts.
3. **Connect the cable, then check that the computer sees the frame.** In a terminal, in the folder with `adb`:

   ```sh
   adb devices
   ```

   The frame should be listed as `device`. If it says `unauthorized`, look at the frame: it asks whether to allow
   this computer. Allow it, and run `adb devices` again.
4. **Install Gingham:**

   ```sh
   adb install gingham-32bit.apk
   ```

   It prints `Success`.
5. **Make Gingham the frame's home screen**, so it comes back by itself after a restart:

   ```sh
   adb shell cmd package set-home-activity co.rileysheehan.gingham/.FrameActivity
   ```

   Then restart the frame (unplug it and plug it back in). It should come up in Gingham, showing a QR code. If the
   frame instead asks which app to use for Home, choose Gingham and *Always*.
6. **Unplug the cable.** From here everything is done from a phone, and later versions install from the frame's own
   Settings, under Updates, without a computer.

**If it goes wrong**

- *`adb devices` lists nothing.* Try another cable or another USB port, check that ADB is on, and on a Frameo frame,
  turn Transfer from computer on again.
- *`INSTALL_FAILED_NO_MATCHING_ABIS`.* The frame is 64-bit only: install `gingham-64bit.apk` or `gingham-either.apk`
  instead.
- *The frame's own photo app comes back after a restart.* Run step 5 again. Installing any other launcher later can
  reset Android's choice of home screen.
- *Going back to the frame's own app.* Set it as the home screen again with step 5, using its package name instead
  (`adb shell cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.HOME` lists
  what can be one), or uninstall Gingham with `adb uninstall co.rileysheehan.gingham`.

Some frames lock their launcher so that nothing else can be installed even this way. If yours refuses, a tablet on a
stand does the same job.
