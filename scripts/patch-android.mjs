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
  ].filter(p => !xml.includes(p))
   .map(p => `    <uses-permission android:name="${p}" />`).join("\n");
  if (perms) xml = xml.replace(/<\/manifest>\s*$/, `${perms}\n</manifest>\n`);
  // Android 11+: Adventure-Lab-App muss sichtbar sein, damit sie per Paketname geöffnet werden kann
  if (!xml.includes("com.groundspeak.react.adventures")) {
    xml = xml.replace(/<\/manifest>\s*$/, `    <queries>\n        <package android:name="com.groundspeak.react.adventures" />\n    </queries>\n</manifest>\n`);
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

console.log(`Android-Projekt angepasst: Version ${pkg.version} (${versionCode})${keystore ? ", signiert" : ", Debug-Signatur"}`);
