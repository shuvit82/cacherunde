# CacheRunde

Geocaching-Rundenfinder: plant Cache-Runden zu Fuß mit echtem Wegerouting, Parkplatzsuche, Unterkünften und persönlicher Fundstatistik.

- **Web-Version:** https://shuvit82.github.io/cacherunde/
- **Android-App:** folgt (wird aus demselben Code mit Capacitor gebaut)

## Aufbau

| Pfad | Inhalt |
|---|---|
| `www/` | Die komplette App (HTML, CSS, JavaScript). Läuft ohne Server direkt im Browser. |
| `www/api-local.js` | Ersetzt den früheren lokalen PowerShell-Server. Fängt alle `/api/...`-Aufrufe ab und spricht die Dienste direkt an. |
| `www/sw.js` | Service Worker: App offline nutzbar, angezeigte Kartenkacheln werden gespeichert. |
| `.github/workflows/` | Automatische Veröffentlichung der Web-Version (und später der Android-APK). |

## Externe Dienste

| Zweck | Dienst |
|---|---|
| Karte | OpenStreetMap-Kacheln |
| Fußrouting | FOSSGIS OSRM (routing.openstreetmap.de) |
| Autorouting | OSRM Demo-Server |
| Ortssuche, Parkplätze | Nominatim |
| Straßenrand-Parken, Unterkünfte, Wald | Overpass API |
| Höhen | Open-Meteo |
| Bewertungen (optional) | Google Places API mit eigenem Schlüssel |

Nur in der Android-App: Fundstatistik direkt von geocaching.com (mit eigenem Login) und Cacherstats-Ranking. Im Browser blockieren diese Seiten den Zugriff; dort gibt es den Import der „My Finds“-Pocket-Query und die manuelle Eingabe.

## Lokal testen

Im Ordner `www` einen beliebigen Webserver starten, z. B.:

```bash
cd www
python -m http.server 8080
```

Dann http://localhost:8080 öffnen.

## Versionen

- **0.13.0** – Kein lokaler Server mehr nötig. PWA mit Icons, Offline-Cache für App und Karten.
- **0.12.1** – Jahresstatistik über geocaching.com-Login und „My Finds“-Import.
- **bis 0.12.0** – Windows-Version mit lokalem PowerShell-Server.
