# CacheRunde – offene Punkte und Optionen

## Option: Geoapify als Hauptanbieter (falls die freien Dienste weiter Probleme machen)
- Ein Schlüssel für Fußrouting, Ortssuche mit Vorschlägen, Ortsnamen (reverse) und Parkplätze (Places API, Kategorie Parken).
- Kostenlos: 3.000 Credits/Tag, 5 Anfragen/s, keine Kreditkarte; 1 einfache Anfrage = 1 Credit.
- Schlüssel NICHT ins Repository, sondern in der App unter „Ich“ eintragen (wie der Google-Schlüssel).
- Freie Dienste (FOSSGIS-Routing, Photon, Overpass, Nominatim) bleiben als Rückfall.
- Optional zusätzlich: OpenRouteService mit Profil „foot-hiking“ (kostenlos, 2.000 Routen/Tag, 40/Minute).

## Cacherstats-Ränge (Welt / Deutschland)
- RankingList.pl liefert die Liste nur per POST (Lang, Loc, RPP, Action=Query); kein Namensfeld sichtbar.
- Am PC mit Claude in Chrome live untersuchen, wie gesucht/geblättert wird; ggf. per Fundzahl (von geocaching.com) gezielt ansteuern.

## Weitere Ideen
- Navigationsansicht mit Live-Standort, Richtungspfeil, Kartenvorrat fürs Gebiet.
- Tracking im Hintergrund mit GPX-Export.

## Offline-Karte (ab 0.22.0)
- Kartendateien (PMTiles, Protomaps-Basiskarte aus OSM) erzeugt der Workflow „Offline-Karte erzeugen“ (Kreis um einen Mittelpunkt), Ablage in der Release `maps` mit Index `maps.json`.
- Erste Karte: Otzberg + 100 km, Zoom 15, 549 MB. Hessen + BW + Bayern geschätzt 1,5–2 GB (eine Datei pro Land, GitHub-Grenze 2 GB je Datei).
- App: Download mit @capacitor/file-transfer nach DATA/maps, Anzeige mit protomaps-leaflet über den lokalen Capacitor-Server (Range-Anfragen). Automatischer Wechsel Offline/OSM je nach Kartenmitte.
- Später: mehrere Karten gleichzeitig, Höhenlinien/Schummerung (Mapterhorn), Outdoor-Stil mit Wanderwegen.

## Cacherstats (gelöst in 0.22.0)
- RankingList.pl nimmt POST Lang=EN, Loc=World|Germany, MA=1, RPP, CACHER=<Name> – ohne Login/Cookies.
- Namenssuche nur bei exakter Schreibweise (Groß/klein). Rückfall: CACHES=<gc-Fundzahl+2>, RPP=500 (bis 2 Seiten), Vergleich ohne Groß/klein oder per Profil-GUID im Link.
