// Passt das von "npx cap add android" erzeugte Android-Projekt an CacheRunde an.
// Wird im GitHub-Actions-Build nach "cap add android" ausgeführt.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const android = path.join(root, "android");
const appDir = path.join(android, "app");
const res = path.join(appDir, "src", "main", "res");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function edit(file, fn) {
  const before = fs.readFileSync(file, "utf8");
  const after = fn(before);
  if (after === before) console.warn(`Hinweis: ${path.relative(root, file)} unverändert`);
  fs.writeFileSync(file, after);
}

// 1) Berechtigungen für GPS-Standort
edit(path.join(appDir, "src", "main", "AndroidManifest.xml"), xml => {
  const perms = [
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
    "android.permission.POST_NOTIFICATIONS",
  ].filter(p => !xml.includes(p))
   .map(p => `    <uses-permission android:name="${p}" />`).join("\n");
  if (perms) xml = xml.replace(/<\/manifest>\s*$/, `${perms}\n</manifest>\n`);
  // Android 11+: Adventure-Lab-App muss sichtbar sein, damit sie per Paketname geöffnet werden kann
  if (!xml.includes("com.groundspeak.react.adventures")) {
    xml = xml.replace(/<\/manifest>\s*$/, `    <queries>\n        <package android:name="com.groundspeak.react.adventures" />\n    </queries>\n</manifest>\n`);
  }
  // Vordergrund-Dienst, der die App während langer Routenberechnungen am Leben hält
  if (!xml.includes(".RoutingService")) {
    xml = xml.replace(/<\/application>/, `    <service android:name=".RoutingService" android:exported="false" android:foregroundServiceType="dataSync" />\n    </application>`);
  }
  return xml;
});

// 2) Version und Signierung
const versionCode = parseInt(process.env.GITHUB_RUN_NUMBER || "1", 10);
const keystore = process.env.CR_KEYSTORE_FILE;
edit(path.join(appDir, "build.gradle"), g => {
  g = g.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
       .replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
  if (keystore && fs.existsSync(keystore) && !g.includes("crRelease")) {
    const ks = keystore.replace(/\\/g, "/");
    g = g.replace(/android\s*\{/, `android {
    signingConfigs {
        crRelease {
            storeFile file("${ks}")
            storePassword System.getenv("CR_KEYSTORE_PASSWORD")
            keyAlias System.getenv("CR_KEY_ALIAS") ?: "cacherunde"
            keyPassword System.getenv("CR_KEYSTORE_PASSWORD")
        }
    }`);
    g = g.replace(/buildTypes\s*\{\s*release\s*\{/, m => `${m}\n            signingConfig signingConfigs.crRelease`);
  }
  return g;
});

// 3) App-Icon
const iconSrc = path.join(root, "resources", "android");
for (const dir of fs.readdirSync(iconSrc)) {
  const target = path.join(res, dir);
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(path.join(iconSrc, dir))) {
    fs.copyFileSync(path.join(iconSrc, dir, f), path.join(target, f));
  }
}
const bg = path.join(res, "values", "ic_launcher_background.xml");
if (fs.existsSync(bg)) {
  edit(bg, x => x.replace(/#[0-9A-Fa-f]{6,8}/, "#0D4F37"));
}

// 4) Eigenes Plugin "FileRange": liest exakt ein Stück einer Datei (für die Offline-Karte).
//    Der lokale Capacitor-Server beachtet bei Range-Anfragen das Ende nicht und liefert bis Dateiende.
const javaDir = path.join(appDir, "src", "main", "java", ...String(JSON.parse(fs.readFileSync(path.join(root, "capacitor.config.json"), "utf8")).appId).split("."));
fs.mkdirSync(javaDir, { recursive: true });
const javaPkg = JSON.parse(fs.readFileSync(path.join(root, "capacitor.config.json"), "utf8")).appId;
fs.writeFileSync(path.join(javaDir, "FileRangePlugin.java"), `package ${javaPkg};

import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.RandomAccessFile;

@CapacitorPlugin(name = "FileRange")
public class FileRangePlugin extends Plugin {
    @PluginMethod
    public void read(PluginCall call) {
        String p = call.getString("path");
        if (p == null) { call.reject("path fehlt"); return; }
        if (p.startsWith("file:")) p = Uri.parse(p).getPath();
        long offset = call.getData().optLong("offset", 0);
        int length = call.getData().optInt("length", 0);
        if (length < 0 || length > 16 * 1024 * 1024) { call.reject("length ungueltig"); return; }
        try (RandomAccessFile f = new RandomAccessFile(p, "r")) {
            long size = f.length();
            int n = (int) Math.max(0, Math.min((long) length, size - offset));
            byte[] buf = new byte[n];
            if (n > 0) { f.seek(offset); f.readFully(buf); }
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(buf, Base64.NO_WRAP));
            ret.put("size", size);
            ret.put("bytes", n);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Lesen fehlgeschlagen: " + e.getMessage());
        }
    }
}
`);
// 5) Plugin "KeepAlive": Vordergrund-Dienst während der Routenberechnung + Benachrichtigung „Route fertig“
fs.writeFileSync(path.join(javaDir, "RoutingService.java"), `package ${javaPkg};

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

public class RoutingService extends Service {
    static final String CHANNEL_RUN = "routing_run";
    static final String CHANNEL_DONE = "routing_done";
    static final int ID_RUN = 4711;

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_RUN, "Routenberechnung läuft", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_DONE, "Route fertig", NotificationManager.IMPORTANCE_DEFAULT));
    }

    static PendingIntent openApp(Context c) {
        Intent i = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (i == null) i = new Intent();
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static Notification.Builder builder(Context c, String channel) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, channel) : new Notification.Builder(c);
        return b.setSmallIcon(c.getApplicationInfo().icon).setContentIntent(openApp(c));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        channels(this);
        String text = intent != null ? intent.getStringExtra("text") : null;
        Notification n = builder(this, CHANNEL_RUN)
            .setContentTitle("CacheRunde")
            .setContentText(text != null ? text : "Route wird berechnet …")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID_RUN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(ID_RUN, n);
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
`);
fs.writeFileSync(path.join(javaDir, "KeepAlivePlugin.java"), `package ${javaPkg};

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "KeepAlive", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class KeepAlivePlugin extends Plugin {
    private boolean notifyAllowed() {
        return Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED;
    }

    @PluginMethod
    public void requestNotify(PluginCall call) {
        if (notifyAllowed()) { JSObject r = new JSObject(); r.put("granted", true); call.resolve(r); return; }
        requestPermissionForAlias("notifications", call, "permCallback");
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        JSObject r = new JSObject(); r.put("granted", notifyAllowed()); call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        try {
            Context c = getContext();
            Intent i = new Intent(c, RoutingService.class);
            i.putExtra("text", call.getString("text", "Route wird berechnet …"));
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
            call.resolve();
        } catch (Exception e) { call.reject("Dienst nicht startbar: " + e.getMessage()); }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try { getContext().stopService(new Intent(getContext(), RoutingService.class)); } catch (Exception e) {}
        call.resolve();
    }

    @PluginMethod
    public void notifyDone(PluginCall call) {
        Context c = getContext();
        if (!notifyAllowed()) { call.reject("Benachrichtigungen nicht erlaubt"); return; }
        RoutingService.channels(c);
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify((int) (System.currentTimeMillis() % 100000), RoutingService.builder(c, RoutingService.CHANNEL_DONE)
            .setContentTitle(call.getString("title", "CacheRunde"))
            .setContentText(call.getString("text", ""))
            .setAutoCancel(true)
            .build());
        call.resolve();
    }
}
`);

const mainActivity = path.join(javaDir, "MainActivity.java");
edit(mainActivity, j => {
  if (j.includes("FileRangePlugin")) return j;
  if (!j.includes("import android.os.Bundle;")) j = j.replace(/(package [^;]+;)/, "$1\n\nimport android.os.Bundle;");
  return j.replace(/public class MainActivity extends BridgeActivity\s*\{\s*\}/,
`public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FileRangePlugin.class);
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
    }
}`);
});
if (!fs.readFileSync(mainActivity, "utf8").includes("registerPlugin(KeepAlivePlugin.class)")) {
  console.error("MainActivity konnte nicht angepasst werden:\n" + fs.readFileSync(mainActivity, "utf8"));
  process.exit(1);
}

console.log(`Android-Projekt angepasst: Version ${pkg.version} (${versionCode})${keystore ? ", signiert" : ", Debug-Signatur"}`);
