/* E&P Lizenz-Portal — Entwickler-Paket je Modul: lizenz_pruefung.py und ENTWICKLER_<code>.md */
"use strict";

const Entwickler = (() => {
  const heute = () => Krypto.datumDE(Krypto.heuteISO());

  function pruefcode(m, fp) {
    return `# -*- coding: utf-8 -*-
"""Lizenzprüfung für das Modul „${m.name}“ (E&P Solutions IT GmbH).

Erzeugt vom E&P Lizenz-Portal am ${heute()}. Datei unverändert ins Modul übernehmen,
z. B. nach <modul>/tools/lizenz_pruefung.py. Anleitung: ENTWICKLER_${m.code}.md

Hier steht nur der ÖFFENTLICHE Schlüssel: Er kann Schlüssel prüfen, aber keine erzeugen.
Benötigt das Python-Paket „cryptography“ (ist in jeder Odoo-Installation vorhanden).
"""

import base64
import json
from datetime import date

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

MODUL = ${JSON.stringify(m.code)}
OEFFENTLICHER_SCHLUESSEL = ${JSON.stringify(m.oeffentlich)}
FINGERABDRUCK = ${JSON.stringify(fp)}  # muss mit dem Lizenz-Portal übereinstimmen
ALTFORMAT = ${m.altformat ? 'True  # Schlüssel enthalten kein Feld "modul"' : "False"}


class LizenzFehler(Exception):
    """Meldung ist auf Deutsch und kann direkt im Banner angezeigt werden."""


def _b64d(text):
    text = text.strip().rstrip("=")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def pruefe_lizenz(schluessel, db_uuid=None, heute=None):
    """Prüft einen Lizenzschlüssel.

    schluessel  Text aus dem Feld „Lizenzschlüssel“
    db_uuid     Wert von ir.config_parameter "database.uuid" (für Schlüssel mit Datenbank-Bindung)
    heute       Datum für die Ablaufprüfung, Standard date.today()

    Gibt bei Erfolg ein dict zurück, z. B. {"kunde": "ACME GmbH", "bis": "2027-10-17", ...}.
    Wirft LizenzFehler, wenn der Schlüssel ungültig, fremd oder abgelaufen ist.
    """
    teile = (schluessel or "").strip().split(".")
    if len(teile) != 2:
        raise LizenzFehler("Kein gültiger Lizenzschlüssel.")
    try:
        daten_roh = _b64d(teile[0])
        Ed25519PublicKey.from_public_bytes(_b64d(OEFFENTLICHER_SCHLUESSEL)).verify(_b64d(teile[1]), daten_roh)
    except (InvalidSignature, ValueError):
        raise LizenzFehler("Lizenzschlüssel ungültig.")
    try:
        daten = json.loads(daten_roh.decode("utf-8"))
        bis = date.fromisoformat(daten["bis"])
    except (ValueError, KeyError, TypeError):
        raise LizenzFehler("Lizenzdaten nicht lesbar.")
    if not ALTFORMAT and daten.get("modul") != MODUL:
        raise LizenzFehler("Lizenzschlüssel gehört zu einem anderen Modul.")
    if (heute or date.today()) > bis:
        raise LizenzFehler("Lizenz abgelaufen am %s." % bis.strftime("%d.%m.%Y"))
    if daten.get("db") and db_uuid is not None and daten["db"] != db_uuid.strip().lower():
        raise LizenzFehler("Lizenz gilt für eine andere Datenbank.")
    return daten
`;
  }

  function anleitung(m, fp) {
    const c = m.code;
    const json = m.altformat
      ? '   `{"kunde": "ACME GmbH", "bis": "2027-10-17"}`'
      : `   \`{"bis":"2027-10-17","kunde":"ACME GmbH","modul":"${c}"}\`\n   Optional zusätzlich \`"db": "<database.uuid>"\`; der Schlüssel gilt dann nur in dieser Odoo-Datenbank.`;
    return `# Lizenzprüfung im Modul „${m.name}“

Stand ${heute()} · E&P Solutions IT GmbH · intern, nur für die Entwicklung

Kunden bekommen von E&P einen Lizenzschlüssel und tragen ihn im Modul ein. Das Modul prüft ihn
**offline**: Es gibt keinen Lizenzserver und keine Internetverbindung. Die Prüfung ist fertig umgesetzt in
\`lizenz_pruefung.py\` — diese Datei unverändert übernehmen.

## Eckdaten

| | |
|---|---|
| Modul-Code | \`${c}\` |
| Verfahren | Ed25519-Signatur |
| Öffentlicher Schlüssel | \`${m.oeffentlich}\` |
| Fingerabdruck | \`${fp}\` |
| Format | ${m.altformat ? 'Altformat ohne Feld "modul"' : "Standard"} |

## So entsteht ein Schlüssel (im Lizenz-Portal bei E&P)

1. Das Portal schreibt die Lizenzdaten als JSON:
${json}
2. Es signiert genau diese JSON-Bytes mit dem **privaten** Schlüssel des Moduls. Den hat nur E&P.
3. Schlüssel = \`base64url(JSON)\` + \`.\` + \`base64url(Signatur)\`, jeweils ohne \`=\` am Ende.

\`bis\` ist der letzte gültige Tag (inklusive). Unbefristete Lizenzen haben \`bis\` = \`2099-12-31\`.

## So prüft das Modul

1. Schlüssel am \`.\` teilen, beide Teile base64url-dekodieren.
2. Signatur mit dem **öffentlichen** Schlüssel gegen die JSON-Bytes prüfen. Wer auch nur ein Zeichen
   ändert (z. B. das Datum), macht die Signatur ungültig.
3. JSON lesen.${m.altformat ? "" : ` \`modul\` muss \`${c}\` sein.`} Ist heute nach \`bis\`, ist die Lizenz abgelaufen.${m.altformat ? "" : " Ist `db` gesetzt, muss es der `database.uuid` entsprechen."}

## Einbau in Odoo (Beispiel)

1. \`lizenz_pruefung.py\` nach \`<modul>/tools/lizenz_pruefung.py\` kopieren
   (\`tools/__init__.py\` anlegen, in der Modul-\`__init__.py\` \`from . import tools\` ergänzen).
2. Schlüssel speichern, z. B. als Systemparameter oder Feld in den Einstellungen.
3. Vor jeder lizenzpflichtigen Funktion prüfen und im Einstellungsdialog einen Banner zeigen:

\`\`\`python
from odoo import _, api, fields, models
from odoo.exceptions import UserError

from ..tools.lizenz_pruefung import LizenzFehler, pruefe_lizenz

PARAM = "${c}.lizenzschluessel"


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    ${c}_lizenzschluessel = fields.Char("Lizenzschlüssel", config_parameter=PARAM)
    ${c}_lizenz_gueltig = fields.Boolean(compute="_compute_${c}_lizenz")
    ${c}_lizenz_meldung = fields.Char(compute="_compute_${c}_lizenz")

    @api.depends("${c}_lizenzschluessel")
    def _compute_${c}_lizenz(self):
        for rec in self:
            try:
                daten = pruefe_lizenz(rec.${c}_lizenzschluessel, **_kontext(self.env))
                rec.${c}_lizenz_gueltig = True
                rec.${c}_lizenz_meldung = "Lizenziert für %s, gültig bis %s" % (
                    daten["kunde"], fields.Date.to_date(daten["bis"]).strftime("%d.%m.%Y"))
            except LizenzFehler as e:
                rec.${c}_lizenz_gueltig = False
                rec.${c}_lizenz_meldung = str(e)


def _kontext(env):
    icp = env["ir.config_parameter"].sudo()
    return {"db_uuid": icp.get_param("database.uuid"), "heute": fields.Date.context_today(env.user)}


def lizenz_erzwingen(env):
    """Am Anfang jeder lizenzpflichtigen Funktion aufrufen."""
    try:
        return pruefe_lizenz(env["ir.config_parameter"].sudo().get_param(PARAM), **_kontext(env))
    except LizenzFehler as e:
        raise UserError(_("${m.name}: %s Bitte E&P Solutions kontaktieren.") % e)
\`\`\`

## Wichtig

- Nur \`OEFFENTLICHER_SCHLUESSEL\` gehört ins Modul. Den **privaten** Schlüssel nie anfragen, nie ins Repo.
- Nichts an der Prüflogik „lockern“, z. B. Fehler abfangen und trotzdem weitermachen: Dann ist die Lizenz wirkungslos.
- Testschlüssel: Im Portal unter Module → ${m.name} steht ein Beispielschlüssel.
  Zum Gegentest ein Zeichen darin ändern: dann muss „Lizenzschlüssel ungültig.“ kommen.
- Bei Fragen: E&P Solutions IT GmbH.
`;
  }

  return { pruefcode, anleitung };
})();
