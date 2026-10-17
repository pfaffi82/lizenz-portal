# E&P Lizenz-Portal (Browser-Version)

Lizenzschlüssel für E&P-Module (goai, BMD, …) ausstellen und verwalten — direkt im Browser, gehostet auf GitHub Pages.

**Aufruf:** https://pfaffi82.github.io/lizenz-portal/

## Wie es funktioniert

- Diese Seite enthält **keine** Schlüssel und **keine** Kundendaten, nur den Code.
- Kunden, Lizenzen und Module liegen in einem **privaten** Daten-Repo (`daten.json`), gelesen und geschrieben über die GitHub-API.
- Die privaten Modul-Schlüssel liegen dort nur **verschlüsselt** (Tresor: AES-256-GCM, Schlüssel aus dem Portal-Passwort, PBKDF2-SHA256 600 000 Runden).
- Signiert wird im Browser (WebCrypto, Ed25519). Die Schlüssel sind Byte für Byte identisch mit der Python-Version.

## Anmelden

1. Einmal pro Gerät: Name + GitHub-Token (Fine-grained, nur das Daten-Repo, „Contents: Read and write“).
2. Danach: Portal-Passwort.

Wer nur die Adresse kennt, kommt ohne Token und Passwort an nichts heran.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html`, `style.css` | Oberfläche (E&P Signature Blue) |
| `krypto.js` | Erzeugen/Prüfen von Schlüsseln, Tresor |
| `speicher.js` | Laden/Speichern über die GitHub-API |
| `entwickler.js` | Entwickler-Paket je Modul (`lizenz_pruefung.py`, Anleitung) |
| `app.js` | Seiten und Abläufe |

© E&P Solutions IT GmbH
