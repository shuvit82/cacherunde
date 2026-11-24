// Kopiert die Kartenbibliotheken aus node_modules nach www/vendor,
// damit die App sie ohne Internet laden kann (Offline-Karte).
import fs from "node:fs";
import path from "node:path";

const out = "www/vendor";
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "leaflet"), { recursive: true });

fs.cpSync("node_modules/leaflet/dist", path.join(out, "leaflet"), { recursive: true });
console.log("Leaflet →", path.join(out, "leaflet"));

const pmDist = "node_modules/protomaps-leaflet/dist";
const pick = ["protomaps-leaflet.js", "protomaps-leaflet.min.js", "protomaps-leaflet.umd.js"]
  .map(f => path.join(pmDist, f)).find(f => fs.existsSync(f));
if (!pick) {
  console.error("protomaps-leaflet: keine UMD-Datei gefunden in", pmDist, fs.readdirSync(pmDist));
  process.exit(1);
}
fs.copyFileSync(pick, path.join(out, "protomaps-leaflet.js"));
console.log("protomaps-leaflet:", pick, "→", path.join(out, "protomaps-leaflet.js"));
