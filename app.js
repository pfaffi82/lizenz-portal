/* E&P Lizenz-Portal — Browser-Version für GitHub Pages.
 *
 * Ablauf: Gerät einmal einrichten (GitHub-Token + Daten-Repo) → mit Passwort anmelden →
 * daten.json aus dem privaten Repo laden, Tresor mit dem Passwort öffnen → Lizenzen im Browser signieren.
 * Auf GitHub Pages liegt nur dieser Code. Schlüssel und Kundendaten liegen verschlüsselt bzw. privat im Daten-Repo.
 */
"use strict";

(() => {
  const STANDARD_REPO = "pfaffi82/eps-lizenz-daten";
  const SITZUNG = "eps-lizenz-sitzung";
  const UNBEGRENZT = "2099-12-31";
  const WARN_TAGE = 30;
  const MIN_PASSWORT = 10;
  const ARTEN = { kunde: "Kunde", test: "Test", intern: "Intern" };
  const LAUFZEITEN = [
    ["t30", "Test · 30 Tage"], ["j1", "1 Jahr"], ["j3", "3 Jahre"], ["j5", "5 Jahre"], ["j10", "10 Jahre"],
    ["unbegrenzt", "Unbegrenzt"], ["tage", "Eigene Anzahl Tage"], ["datum", "Bis Datum"],
  ];
  const PFLICHT_FELDER = {
    ansprechpartner: "Ansprechpartner", telefon: "Telefon", email: "E-Mail", adresse: "Adresse",
    datenbank: "Datenbank-Bezeichnung (pro Lizenz)",
  };
  const KUNDEN_FELDER = ["name", "ansprechpartner", "telefon", "email", "adresse", "notiz"];

  let daten = null;          // Inhalt von daten.json
  let schluessel = {};       // { modulcode: privater Schlüssel } — nur im Speicher dieser Sitzung
  let fingerabdruecke = {};  // { modulcode: "XXXX XXXX …" }
  let letztesErgebnis = null;

  const $ = (sel, wurzel = document) => wurzel.querySelector(sel);
  const $$ = (sel, wurzel = document) => Array.from(wurzel.querySelectorAll(sel));
  const LF = Krypto.LizenzFehler;

  // ---------- Hilfen ----------

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const de = Krypto.datumDE;
  const heute = Krypto.heuteISO;
  const jetzt = () => new Date().toISOString().slice(0, 19);

  function plusTage(iso, tage) {
    const [j, m, t] = iso.split("-").map(Number);
    const d = new Date(j, m - 1, t + tage);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function plusJahre(iso, jahre) {
    const [j, m, t] = iso.split("-").map(Number);
    const tag = m === 2 && t === 29 ? 28 : t;
    return `${j + jahre}-${String(m).padStart(2, "0")}-${String(tag).padStart(2, "0")}`;
  }

  function status(bis) {
    const [j, m, t] = bis.split("-").map(Number);
    const [hj, hm, ht] = heute().split("-").map(Number);
    const rest = Math.round((new Date(j, m - 1, t) - new Date(hj, hm - 1, ht)) / 86400000);
    if (rest < 0) return ["abgelaufen", rest];
    if (rest <= WARN_TAGE) return ["bald", rest];
    return ["gueltig", rest];
  }

  function statusPille(bis) {
    const [st, rest] = status(bis);
    const text = st === "abgelaufen" ? "abgelaufen" : bis === UNBEGRENZT ? "unbefristet" : `noch ${rest} Tage`;
    return `<span class="pille ${st}">${text}</span>`;
  }

  const artPille = (art) => `<span class="pille art ${esc(art || "kunde")}">${ARTEN[art] || "Kunde"}</span>`;

  function meldung(text, art = "ok") {
    const el = document.createElement("div");
    el.className = `meldung ${art === "ok" ? "ok" : "fehler"}`;
    el.textContent = text;
    $("#meldungen").appendChild(el);
    setTimeout(() => el.remove(), art === "ok" ? 5000 : 12000);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bestaetigen(titel, text, knopf = "OK, löschen") {
    return new Promise((fertig) => {
      const dlg = $("#bestaetigen");
      $("#b-titel").textContent = titel;
      $("#b-text").textContent = text;
      $("#b-ja").textContent = knopf;
      const zu = (wert) => { dlg.close(); $("#b-ja").onclick = $("#b-nein").onclick = null; fertig(wert); };
      $("#b-ja").onclick = () => zu(true);
      $("#b-nein").onclick = () => zu(false);
      dlg.oncancel = () => zu(false);
      dlg.showModal();
      $("#b-nein").focus();
    });
  }

  function herunterladen(name, inhalt, typ) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([inhalt], { type: typ }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function formWerte(form) {
    const w = {};
    new FormData(form).forEach((v, k) => { w[k] = typeof v === "string" ? v.trim() : v; });
    return w;
  }

  function zeige(html) {
    $("#inhalt").innerHTML = html;
  }

  function hashTeile() {
    const [pfad, query] = (location.hash.slice(1) || "/").split("?");
    return { teile: pfad.split("/").filter(Boolean), params: new URLSearchParams(query || "") };
  }

  // ---------- Daten ----------

  const pflicht = () => new Set(daten.einstellungen?.pflicht ?? Object.keys(PFLICHT_FELDER));
  const modul = (code) => daten.module.find((m) => m.code === code);
  const kunde = (id) => daten.kunden.find((k) => k.id === Number(id));
  const naechsteId = (liste) => liste.reduce((max, x) => Math.max(max, x.id || 0), 0) + 1;
  const ich = () => Speicher.geraet()?.name || "unbekannt";

  async function aendern(fn, nachricht) {
    try {
      const r = fn(daten);
      await Speicher.speichern(daten, nachricht);
      return r;
    } catch (e) {
      if (e.message !== "Konflikt") throw e;
      daten = await Speicher.laden();  // jemand anderes hat gespeichert: neu laden und Änderung erneut anwenden
      const r = fn(daten);
      await Speicher.speichern(daten, nachricht);
      return r;
    }
  }

  async function fingerabdrueckeNeu() {
    fingerabdruecke = {};
    for (const m of daten.module) fingerabdruecke[m.code] = await Krypto.fingerabdruck(m.oeffentlich);
  }

  function kundeAusFormular(w, prefix = "") {
    const k = {};
    KUNDEN_FELDER.forEach((f) => { k[f] = (w[prefix + f] || "").trim(); });
    if (!k.name) throw new LF("Firmenname des Kunden fehlt.");
    const fehlend = [...pflicht()].filter((f) => f in k && !k[f]).map((f) => PFLICHT_FELDER[f]);
    if (fehlend.length) throw new LF(`Pflichtfelder fehlen: ${fehlend.join(", ")}.`);
    if (k.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(k.email)) throw new LF("E-Mail-Adresse ist ungültig.");
    return k;
  }

  async function pruefeAlle(text, dbUuid) {
    for (const m of daten.module) {
      try {
        return [m, await Krypto.pruefe(text, m.oeffentlich, m.altformat ? null : m.code, dbUuid)];
      } catch (e) {
        if (e.message.startsWith("Kein gültiges")) throw e;
        if (!e.message.startsWith("Signatur ungültig")) return [m, e];
      }
    }
    throw new LF("Signatur ungültig — Schlüssel wurde verändert oder gehört zu keinem Modul hier.");
  }

  // ---------- Sitzung ----------

  function sitzungSpeichern() {
    try { sessionStorage.setItem(SITZUNG, JSON.stringify(schluessel)); } catch (e) { /* ohne geht's auch */ }
  }

  function abmelden() {
    try { sessionStorage.removeItem(SITZUNG); } catch (e) { /* egal */ }
    schluessel = {};
    daten = null;
    letztesErgebnis = null;
    $("#kopf").hidden = true;
    location.hash = "#/";
    seiteAnmelden();
  }

  async function start() {
    if (!(await Krypto.unterstuetzt())) {
      zeige(`<div class="karte"><h1>Browser zu alt</h1><p class="unter">Dieser Browser kann keine Ed25519-Signaturen. Bitte aktuelles Chrome, Edge, Firefox oder Safari verwenden.</p></div>`);
      return;
    }
    if (!Speicher.geraet()) return seiteGeraet();
    let gespeichert = null;
    try { gespeichert = JSON.parse(sessionStorage.getItem(SITZUNG)); } catch (e) { /* keine Sitzung */ }
    if (gespeichert && Object.keys(gespeichert).length) {
      try {
        daten = await Speicher.laden();
        if (daten && daten.tresor) {
          schluessel = gespeichert;
          await fingerabdrueckeNeu();
          return angemeldet();
        }
      } catch (e) {
        meldung(e.message, "fehler");
      }
    }
    seiteAnmelden();
  }

  async function angemeldet() {
    $("#kopf").hidden = false;
    $("#wer").textContent = ich();
    route();
  }

  // ---------- Anmeldung & Einrichtung ----------

  function logoKarte(inner) {
    return `<div class="karte hervor" style="max-width:520px;margin:32px auto">
      <img src="assets/horizontal-full-color-on-light.svg" alt="E&amp;P Solutions" style="height:40px;display:block;margin-bottom:24px">${inner}</div>`;
  }

  function seiteGeraet() {
    const g = Speicher.geraet() || {};
    zeige(logoKarte(`
      <h1>Gerät einrichten</h1>
      <p class="unter">Einmal pro Gerät und Browser. Danach reicht das Passwort.</p>
      <form data-aktion="geraet">
        <label for="name" class="pflicht">Dein Name <small>steht im Protokoll bei „ausgestellt von“</small></label>
        <input id="name" name="name" required maxlength="60" value="${esc(g.name || "")}" placeholder="z. B. Dietmar">
        <label for="token" class="pflicht">GitHub-Zugangsschlüssel (Token)</label>
        <input id="token" name="token" type="password" required autocomplete="off" placeholder="github_pat_…">
        <details style="margin-top:10px"><summary>So bekommst du den Token (3 Minuten)</summary>
          <ol class="klein" style="padding-left:18px">
            <li>Auf GitHub anmelden, dann <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained token erstellen</a> öffnen.</li>
            <li>Name „Lizenz-Portal“, Ablauf z. B. 1 Jahr.</li>
            <li>Repository access: <b>Only select repositories</b> → <code>${esc(g.repo || STANDARD_REPO)}</code>.</li>
            <li>Permissions → Repository permissions → <b>Contents: Read and write</b>.</li>
            <li>„Generate token“, den Token kopieren und hier einfügen. Im Passwort-Manager ablegen.</li>
          </ol></details>
        <details style="margin-top:10px"><summary>Daten-Repo ändern</summary>
          <label for="repo">Repo für die Daten (privat!)</label>
          <input id="repo" name="repo" value="${esc(g.repo || STANDARD_REPO)}" pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+">
        </details>
        <p style="margin-top:24px;margin-bottom:0"><button style="width:100%">Weiter</button></p>
      </form>`));
  }

  function seiteAnmelden() {
    const g = Speicher.geraet();
    zeige(logoKarte(`
      <h1>Lizenz-Portal</h1>
      <p class="unter">Angemeldet als <b>${esc(g.name)}</b> · Daten in <code>${esc(g.repo)}</code></p>
      <form data-aktion="anmelden">
        <label for="passwort">Passwort</label>
        <input id="passwort" name="passwort" type="password" autocomplete="current-password" required autofocus>
        <p style="margin-top:24px"><button style="width:100%" id="anmelde-knopf">Anmelden</button></p>
      </form>
      <p class="klein" style="margin-bottom:0"><a href="#" data-klick="geraet-neu">Gerät neu einrichten (anderer Token oder Name)</a></p>`));
    setTimeout(() => $("#passwort")?.focus(), 50);
  }

  function seiteErsteinrichtung(hatDaten) {
    const goai = hatDaten && daten.module?.find((m) => m.code === "goai");
    zeige(logoKarte(`
      <h1>Ersteinrichtung</h1>
      <p class="unter">Im Daten-Repo gibt es noch keinen Schlüssel-Tresor. Lege das Passwort fest und hinterlege den goai-Schlüssel.</p>
      <form data-aktion="einrichten">
        <label for="p1" class="pflicht">Passwort <small>min. ${MIN_PASSWORT} Zeichen</small></label>
        <input id="p1" name="p1" type="password" minlength="${MIN_PASSWORT}" required autocomplete="new-password">
        <label for="p2" class="pflicht">Passwort wiederholen</label>
        <input id="p2" name="p2" type="password" minlength="${MIN_PASSWORT}" required autocomplete="new-password">
        <label for="goai" class="pflicht">Privater goai-Schlüssel</label>
        <input id="goai" name="goai" required autocomplete="off" placeholder="43 Zeichen, aus dem Passwort-Manager">
        ${goai ? `<p class="klein">Muss zum bisherigen goai-Fingerabdruck passen.</p>` : ""}
        <p style="margin-top:24px;margin-bottom:0"><button style="width:100%">Einrichten</button></p>
      </form>`));
  }

  const aktionen = {};

  aktionen.geraet = async (w) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(w.repo || STANDARD_REPO)) throw new LF("Repo bitte als besitzer/name angeben.");
    Speicher.geraetSpeichern({ name: w.name, token: w.token, repo: w.repo || STANDARD_REPO });
    await Speicher.laden();  // prüft Token und Repo
    meldung("Gerät eingerichtet.");
    seiteAnmelden();
  };

  aktionen.anmelden = async (w) => {
    $("#anmelde-knopf").textContent = "Prüfe …";
    try {
      daten = await Speicher.laden();
      if (!daten || !daten.tresor) return seiteErsteinrichtung(!!daten);
      schluessel = await Krypto.tresorOeffnen(daten.tresor, w.passwort);
      sitzungSpeichern();
      await fingerabdrueckeNeu();
      angemeldet();
    } finally {
      const k = $("#anmelde-knopf");
      if (k) k.textContent = "Anmelden";
    }
  };

  aktionen.einrichten = async (w) => {
    if (w.p1.length < MIN_PASSWORT || w.p1 !== w.p2) throw new LF(`Passwort: mindestens ${MIN_PASSWORT} Zeichen, beide gleich.`);
    const pub = await Krypto.oeffentlichAus(w.goai);
    daten = daten || { version: 1, module: [], kunden: [], lizenzen: [], einstellungen: { pflicht: Object.keys(PFLICHT_FELDER) } };
    const goai = daten.module.find((m) => m.code === "goai");
    if (goai && goai.oeffentlich !== pub) throw new LF("Dieser Schlüssel passt nicht zum bisherigen goai-Schlüssel (Fingerabdruck weicht ab).");
    if (!goai) daten.module.unshift({ code: "goai", name: "goai", beschreibung: "KI-Connector für Odoo", oeffentlich: pub, altformat: true, erstellt_am: jetzt() });
    schluessel = { goai: w.goai.trim() };
    daten.tresor = await Krypto.tresorSchliessen(schluessel, w.p1);
    await Speicher.speichern(daten, "Lizenz-Portal: Ersteinrichtung");
    sitzungSpeichern();
    await fingerabdrueckeNeu();
    meldung("Eingerichtet. Ab jetzt mit diesem Passwort anmelden.");
    angemeldet();
  };

  // ---------- Seiten ----------

  function route() {
    if (!daten) return;
    const { teile, params } = hashTeile();
    const seite = teile[0] || "ausstellen";
    $$("#nav a").forEach((a) => a.classList.toggle("aktiv", a.dataset.seite === seite));
    const seiten = { ausstellen: seiteAusstellen, kunden: seiteKunden, lizenzen: seiteLizenzen, pruefen: seitePruefen,
                     module: seiteModule, einstellungen: seiteEinstellungen };
    (seiten[seite] || seiteAusstellen)(teile.slice(1), params);
  }

  function seiteAusstellen(_, params) {
    const gewaehlt = params.get("modul") || daten.module[0]?.code;
    const vorKunde = params.get("kunde") || "";
    const p = pflicht();
    const pk = (f) => (p.has(f) ? "pflicht" : "");
    const e = letztesErgebnis;
    letztesErgebnis = null;
    const ergebnis = e ? `
      <div class="karte hervor">
        <div class="reihe" style="align-items:baseline">
          <h2 style="margin:0">${esc(e.modulName)} · ${esc(e.kunde.name)}${e.datenbank ? " · " + esc(e.datenbank) : ""}</h2>
          <span style="text-align:right">${artPille(e.art)} <span class="pille gueltig">${e.bis === UNBEGRENZT ? "unbefristet" : "gültig bis " + de(e.bis)}</span></span>
        </div>
        <div class="schluessel" id="neu" style="margin-top:14px">${esc(e.schluessel)}</div>
        <p class="reihe" style="align-items:center;margin-bottom:0">
          <span style="flex:0 0 auto"><button type="button" data-kopieren="neu">Schlüssel kopieren</button></span>
          <span class="klein">Im Modul ${esc(e.modulName)} in das Feld „Lizenzschlüssel“ einfügen.</span>
        </p>
        <details style="margin-top:16px"><summary>Text für den Kunden${e.kunde.email ? " (" + esc(e.kunde.email) + ")" : ""}</summary>
          <textarea id="kundentext" rows="10" style="margin-top:10px;font-family:inherit;font-size:14px">${esc(kundentext(e))}</textarea>
          <p><button type="button" class="zweit" data-kopieren="kundentext">Text kopieren</button>
          ${e.kunde.email ? `<a class="knopf zweit" href="mailto:${esc(e.kunde.email)}?subject=${encodeURIComponent("Lizenzschlüssel " + e.modulName)}&body=${encodeURIComponent(kundentext(e))}">E-Mail öffnen</a>` : ""}</p>
        </details>
      </div>` : "";
    const bald = daten.lizenzen.filter((l) => l.bis >= heute()).sort((a, b) => a.bis.localeCompare(b.bis)).slice(0, 5);
    zeige(`${ergebnis}
      <div class="karte">
        <h1>Lizenzschlüssel ausstellen</h1>
        <p class="unter">Modul wählen, Kunde angeben, Laufzeit wählen. Felder mit <span class="pflicht"></span> sind Pflicht.</p>
        <form data-aktion="ausstellen" id="formular">
          <label>Modul</label>
          <div class="kacheln">${daten.module.map((m) => `
            <input type="radio" name="modul" id="m-${esc(m.code)}" value="${esc(m.code)}" data-alt="${m.altformat ? 1 : 0}" ${m.code === gewaehlt ? "checked" : ""}>
            <label for="m-${esc(m.code)}">${esc(m.name)}</label>`).join("")}
          </div>
          <h2 style="margin-top:24px">Kunde</h2>
          <label for="kunde_id">Bestehender oder neuer Kunde</label>
          <select id="kunde_id" name="kunde_id">
            <option value="neu">+ Neuen Kunden anlegen</option>
            ${[...daten.kunden].sort((a, b) => a.name.localeCompare(b.name)).map((k) => `
              <option value="${k.id}" ${String(k.id) === vorKunde ? "selected" : ""}>${esc(k.name)}${k.ansprechpartner ? " — " + esc(k.ansprechpartner) : ""}</option>`).join("")}
          </select>
          <div id="neuer-kunde">
            <div class="raster">
              <div><label for="k_name" class="pflicht">Firmenname</label><input id="k_name" name="k_name" maxlength="120" placeholder="ACME GmbH"></div>
              <div><label for="k_ansprechpartner" class="${pk("ansprechpartner")}">Ansprechpartner</label><input id="k_ansprechpartner" name="k_ansprechpartner" maxlength="120"></div>
              <div><label for="k_telefon" class="${pk("telefon")}">Telefon</label><input id="k_telefon" name="k_telefon" type="tel" maxlength="40"></div>
              <div><label for="k_email" class="${pk("email")}">E-Mail</label><input id="k_email" name="k_email" type="email" maxlength="120"></div>
            </div>
            <label for="k_adresse" class="${pk("adresse")}">Adresse</label>
            <textarea id="k_adresse" name="k_adresse" rows="2" maxlength="300" style="font-family:inherit;font-size:15px" placeholder="Straße Nr., PLZ Ort"></textarea>
          </div>
          <h2 style="margin-top:24px">Lizenz</h2>
          <div class="reihe">
            <div style="flex:2"><label for="datenbank" class="${pk("datenbank")}">Datenbank-Bezeichnung</label>
              <input id="datenbank" name="datenbank" maxlength="120" placeholder="z. B. acme-produktiv oder acme.odoo.com" value="${esc(params.get("db") || "")}" ${p.has("datenbank") ? "required" : ""}></div>
            <div><label>Art</label><div class="segment">${Object.entries(ARTEN).map(([w, n]) => `
              <input type="radio" name="art" id="art-${w}" value="${w}" ${w === "kunde" ? "checked" : ""}><label for="art-${w}">${n}</label>`).join("")}</div></div>
          </div>
          <label>Laufzeit</label>
          <div class="kacheln">${LAUFZEITEN.map(([w, n]) => `
            <input type="radio" name="laufzeit" id="lz-${w}" value="${w}" ${w === "j1" ? "checked" : ""}><label for="lz-${w}">${n}</label>`).join("")}
          </div>
          <div class="reihe">
            <div id="f-tage" hidden><label for="tage">Anzahl Tage</label><input id="tage" name="tage" type="number" min="1" max="36500" value="90"></div>
            <div id="f-datum" hidden><label for="bis">Gültig bis</label><input id="bis" name="bis" type="date" min="${heute()}"></div>
          </div>
          <label for="notiz">Notiz <small>optional, nur intern</small></label>
          <input id="notiz" name="notiz" maxlength="300" placeholder="z. B. Angebot 2026-118">
          <div id="f-db" hidden><details style="margin-top:16px"><summary>Erweitert: an eine Odoo-Datenbank binden</summary>
            <label for="db_uuid">Odoo database.uuid <small>Schlüssel läuft dann nur in dieser Datenbank</small></label>
            <input id="db_uuid" name="db_uuid" maxlength="64" placeholder="leer lassen = jede Datenbank"></details></div>
          <p style="margin-top:24px;margin-bottom:0"><button id="erzeugen">Schlüssel erzeugen</button></p>
        </form>
      </div>
      ${bald.length ? `<div class="karte"><h2>Laufen als Nächstes ab</h2><div class="tabelle"><table>
        <tr><th>Modul</th><th>Kunde</th><th>Datenbank</th><th>Gültig bis</th><th>Status</th><th></th></tr>
        ${bald.map((l) => `<tr><td>${esc(modul(l.modul)?.name || l.modul)}</td>
          <td><a href="#/kunden/${l.kunde_id}"><b>${esc(l.kunde)}</b></a></td><td class="klein">${esc(l.datenbank || "")}</td>
          <td>${de(l.bis)}</td><td>${statusPille(l.bis)}</td>
          <td style="text-align:right"><a href="${verlaengernLink(l)}">Verlängern</a></td></tr>`).join("")}
      </table></div></div>` : ""}`);
    ausstellenSichtbar();
  }

  const verlaengernLink = (l) => `#/?modul=${encodeURIComponent(l.modul)}&kunde=${l.kunde_id}&db=${encodeURIComponent(l.datenbank || "")}`;

  function ausstellenSichtbar() {
    const f = $("#formular");
    if (!f) return;
    const lz = $("input[name=laufzeit]:checked", f).value;
    $("#f-tage").hidden = lz !== "tage";
    $("#f-datum").hidden = lz !== "datum";
    $("#bis").required = lz === "datum";
    const m = $("input[name=modul]:checked", f);
    $("#f-db").hidden = !m || m.dataset.alt === "1";
    const neu = $("#kunde_id").value === "neu";
    $("#neuer-kunde").hidden = !neu;
    $$("#neuer-kunde input, #neuer-kunde textarea").forEach((el) => {
      el.required = neu && $(`label[for=${el.id}]`, f).classList.contains("pflicht");
    });
  }

  function kundentext(e) {
    return `Guten Tag${e.kunde.ansprechpartner ? " " + e.kunde.ansprechpartner : ""},

anbei Ihr Lizenzschlüssel für ${e.modulName} (${e.kunde.name}${e.datenbank ? ", Datenbank " + e.datenbank : ""}), ${e.bis === UNBEGRENZT ? "unbefristet gültig" : "gültig bis " + de(e.bis)}:

${e.schluessel}

Bitte in Odoo im Modul ${e.modulName} in das Feld „Lizenzschlüssel“ einfügen und speichern. Ein grüner Hinweis bestätigt die gültige Lizenz.

Freundliche Grüße
E&P Solutions IT GmbH`;
  }

  aktionen.ausstellen = async (w) => {
    const m = modul(w.modul);
    if (!m) throw new LF("Modul wählen.");
    if (!schluessel[m.code]) throw new LF(`Für ${m.name} ist kein privater Schlüssel im Tresor.`);
    const h = heute();
    let bis;
    if (w.laufzeit === "datum") bis = w.bis;
    else if (w.laufzeit === "unbegrenzt") bis = UNBEGRENZT;
    else if (/^j\d+$/.test(w.laufzeit)) bis = plusJahre(h, Number(w.laufzeit.slice(1)));
    else {
      const tage = w.laufzeit === "t30" ? 30 : parseInt(w.tage, 10);
      if (!(tage >= 1)) throw new LF("Laufzeit muss mindestens 1 Tag sein.");
      bis = plusTage(h, tage);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bis || "")) throw new LF("Ablaufdatum fehlt.");
    if (bis < h) throw new LF("Ablaufdatum liegt in der Vergangenheit.");
    if (pflicht().has("datenbank") && !w.datenbank) throw new LF("Pflichtfeld fehlt: Datenbank-Bezeichnung.");
    const neuerKunde = w.kunde_id === "neu" ? kundeAusFormular(w, "k_") : null;
    const k0 = neuerKunde ? null : kunde(w.kunde_id);
    const name = neuerKunde ? neuerKunde.name : k0?.name;
    if (!name) throw new LF("Kunde wählen.");
    const text = await Krypto.erzeuge(schluessel[m.code], name, bis, m.altformat ? null : m.code, m.altformat ? null : w.db_uuid);
    const geprueft = await Krypto.pruefe(text, m.oeffentlich, m.altformat ? null : m.code);  // Selbsttest
    const art = ARTEN[w.art] ? w.art : "kunde";
    const k = await aendern((d) => {
      let kk = neuerKunde ? null : d.kunden.find((x) => x.id === k0.id);
      if (!kk) {
        kk = { id: naechsteId(d.kunden), ...(neuerKunde || k0), erstellt_von: ich(), erstellt_am: jetzt() };
        d.kunden.push(kk);
      }
      d.lizenzen.push({ id: naechsteId(d.lizenzen), modul: m.code, kunde_id: kk.id, kunde: kk.name, datenbank: w.datenbank,
        von: h, bis, db: geprueft.db || null, notiz: w.notiz, schluessel: text, erstellt_von: ich(), erstellt_am: jetzt(), art });
      return kk;
    }, `Lizenz ${m.name} für ${name}`);
    letztesErgebnis = { schluessel: text, bis, art, kunde: k, datenbank: w.datenbank, modulName: m.name };
    if (location.hash === "#/") seiteAusstellen([], new URLSearchParams());
    else location.hash = "#/";  // hashchange zeigt die Seite mit dem Ergebnis
  };

  function seiteLizenzen(_, params) {
    const zeilen = [...daten.lizenzen].sort((a, b) => a.bis.localeCompare(b.bis));
    const n = { gueltig: 0, bald: 0, abgelaufen: 0 };
    zeilen.forEach((l) => { n[status(l.bis)[0]]++; });
    zeige(`
      <div class="kennzahlen">
        <div class="kennzahl"><b>${zeilen.length}</b><span>Lizenzen</span></div>
        <div class="kennzahl"><b>${n.gueltig}</b><span>gültig</span></div>
        <div class="kennzahl ${n.bald ? "warn" : ""}"><b>${n.bald}</b><span>laufen in ≤ 30 Tagen ab</span></div>
        <div class="kennzahl"><b>${n.abgelaufen}</b><span>abgelaufen</span></div>
      </div>
      <div class="karte">
        <div class="reihe" style="align-items:center"><h1 style="margin:0">Lizenzen</h1>
          <span style="text-align:right;flex:0 0 auto"><button type="button" class="zweit" data-klick="csv">CSV exportieren</button></span></div>
        ${zeilen.length ? `
        <div class="reihe" style="margin-top:16px">
          <input id="suche" type="search" placeholder="Suchen: Kunde, Datenbank, Notiz …" style="flex:2">
          ${daten.module.length > 1 ? `<select id="filter-modul"><option value="">Alle Module</option>${daten.module.map((m) => `<option value="${esc(m.code)}" ${params.get("modul") === m.code ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>` : ""}
          <select id="filter-art"><option value="">Alle Arten</option>${Object.entries(ARTEN).map(([w, nn]) => `<option value="${w}">${nn}</option>`).join("")}</select>
        </div>
        <div class="tabelle"><table style="margin-top:12px" id="tabelle">
          <tr><th>Modul</th><th>Kunde</th><th>Art</th><th>Gültig bis</th><th>Status</th><th>Ausgestellt</th><th>Schlüssel</th><th></th></tr>
          ${zeilen.map((l) => lizenzZeile(l, true)).join("")}
        </table></div>` : `<p class="klein">Noch keine Lizenzen ausgestellt.</p>`}
      </div>`);
    filtern();
  }

  function lizenzZeile(l, mitKunde) {
    return `<tr data-art="${esc(l.art || "kunde")}" data-modul="${esc(l.modul)}" data-text="${esc((l.kunde + " " + (l.datenbank || "") + " " + (l.notiz || "")).toLowerCase())}">
      <td><b>${esc(modul(l.modul)?.name || l.modul)}</b></td>
      ${mitKunde ? `<td><a href="#/kunden/${l.kunde_id}"><b>${esc(l.kunde)}</b></a>${l.datenbank ? `<br><span class="klein">DB ${esc(l.datenbank)}</span>` : ""}${l.notiz ? `<br><span class="klein">${esc(l.notiz)}</span>` : ""}</td>`
                 : `<td>${esc(l.datenbank || "")}${l.notiz ? `<br><span class="klein">${esc(l.notiz)}</span>` : ""}</td>`}
      <td>${artPille(l.art)}</td>
      <td>${de(l.bis)}</td>
      <td>${statusPille(l.bis)}<br><a class="klein" href="${verlaengernLink(l)}">Verlängern</a></td>
      <td class="klein">${de((l.erstellt_am || "").slice(0, 10))}<br>${esc(l.erstellt_von || "")}</td>
      <td><details><summary>anzeigen</summary><div class="schluessel" id="k${l.id}" style="margin:8px 0">${esc(l.schluessel)}</div>
        <button type="button" class="zweit klein-k" data-kopieren="k${l.id}">Kopieren</button></details></td>
      <td style="text-align:right"><button type="button" class="gefahr klein-k" data-klick="lizenz-loeschen" data-id="${l.id}">Löschen</button></td>
    </tr>`;
  }

  function filtern() {
    const s = $("#suche");
    if (!s) return;
    const q = s.value.toLowerCase().trim();
    const a = $("#filter-art")?.value || "";
    const m = $("#filter-modul")?.value || "";
    $$("#tabelle tr[data-text]").forEach((tr) => {
      tr.hidden = (q && !tr.dataset.text.includes(q)) || (a && tr.dataset.art !== a) || (m && tr.dataset.modul !== m);
    });
  }

  function seiteKunden(teile) {
    if (teile[0]) return seiteKunde(Number(teile[0]));
    const zeilen = [...daten.kunden].sort((a, b) => a.name.localeCompare(b.name));
    zeige(`<div class="karte">
      <div class="reihe" style="align-items:center"><h1 style="margin:0">Kunden (${zeilen.length})</h1>
        <span style="text-align:right;flex:0 0 auto"><a class="knopf" href="#/">Neue Lizenz</a></span></div>
      ${zeilen.length ? `<input id="suche" type="search" placeholder="Suchen: Firma, Ansprechpartner, E-Mail, Ort …" style="margin-top:16px">
      <div class="tabelle"><table style="margin-top:12px" id="tabelle">
        <tr><th>Firma</th><th>Ansprechpartner</th><th>Kontakt</th><th>Lizenzen</th><th>Läuft bis</th></tr>
        ${zeilen.map((k) => {
          const liz = daten.lizenzen.filter((l) => l.kunde_id === k.id);
          const max = liz.reduce((m, l) => (l.bis > m ? l.bis : m), "");
          return `<tr data-text="${esc([k.name, k.ansprechpartner, k.email, k.adresse, k.telefon].join(" ").toLowerCase())}">
            <td><a href="#/kunden/${k.id}"><b>${esc(k.name)}</b></a>${k.adresse ? `<br><span class="klein">${esc(k.adresse.replace(/\n/g, ", "))}</span>` : ""}
              ${!k.ansprechpartner && !k.email ? `<br><span class="pille bald">Daten unvollständig</span>` : ""}</td>
            <td>${esc(k.ansprechpartner || "")}</td>
            <td class="klein">${k.email ? `<a href="mailto:${esc(k.email)}">${esc(k.email)}</a><br>` : ""}${esc(k.telefon || "")}</td>
            <td>${liz.length}</td><td>${de(max)}</td></tr>`;
        }).join("")}
      </table></div>` : `<p class="klein">Noch keine Kunden. Kunden werden beim Ausstellen einer Lizenz angelegt.</p>`}
    </div>`);
  }

  function seiteKunde(id) {
    const k = kunde(id);
    if (!k) { zeige(`<div class="karte"><h1>Kunde nicht gefunden</h1><p><a href="#/kunden">← Alle Kunden</a></p></div>`); return; }
    const p = pflicht();
    const feld = (f, label, typ = "text") => `<div><label for="${f}" class="${f === "name" || p.has(f) ? "pflicht" : ""}">${label}</label>
      <input id="${f}" name="${f}" type="${typ}" maxlength="120" value="${esc(k[f] || "")}" ${f === "name" || p.has(f) ? "required" : ""}></div>`;
    const liz = daten.lizenzen.filter((l) => l.kunde_id === k.id).sort((a, b) => a.bis.localeCompare(b.bis));
    zeige(`<p><a href="#/kunden">← Alle Kunden</a></p>
      <div class="karte">
        <div class="reihe" style="align-items:center"><h1 style="margin:0">${esc(k.name)}</h1>
          <span style="text-align:right;flex:0 0 auto"><a class="knopf" href="#/?kunde=${k.id}">Neue Lizenz für diesen Kunden</a></span></div>
        <form data-aktion="kunde-speichern" data-id="${k.id}">
          <div class="raster">${feld("name", "Firmenname")}${feld("ansprechpartner", "Ansprechpartner")}${feld("telefon", "Telefon", "tel")}${feld("email", "E-Mail", "email")}</div>
          <label for="adresse" class="${p.has("adresse") ? "pflicht" : ""}">Adresse</label>
          <textarea id="adresse" name="adresse" rows="2" maxlength="300" style="font-family:inherit;font-size:15px" ${p.has("adresse") ? "required" : ""}>${esc(k.adresse || "")}</textarea>
          <label for="notiz">Notiz <small>intern</small></label>
          <input id="notiz" name="notiz" maxlength="300" value="${esc(k.notiz || "")}">
          <p style="margin-bottom:0;margin-top:20px"><button>Speichern</button></p>
        </form>
      </div>
      <div class="karte"><h2>Lizenzen (${liz.length})</h2>
        ${liz.length ? `<div class="tabelle"><table><tr><th>Modul</th><th>Datenbank</th><th>Art</th><th>Gültig bis</th><th>Status</th><th>Ausgestellt</th><th>Schlüssel</th><th></th></tr>
          ${liz.map((l) => lizenzZeile(l, false)).join("")}</table></div>` : `<p class="klein">Keine Lizenzen.</p>`}
      </div>
      <button type="button" class="gefahr" data-klick="kunde-loeschen" data-id="${k.id}">Kunden löschen</button>`);
  }

  aktionen["kunde-speichern"] = async (w, form) => {
    const werte = kundeAusFormular(w);
    const id = Number(form.dataset.id);
    await aendern((d) => {
      const k = d.kunden.find((x) => x.id === id);
      if (!k) throw new LF("Kunde wurde zwischenzeitlich gelöscht.");
      Object.assign(k, werte);
      d.lizenzen.filter((l) => l.kunde_id === id).forEach((l) => { l.kunde = werte.name; });
    }, `Kunde ${werte.name} geändert`);
    meldung("Kundendaten gespeichert.");
    seiteKunde(id);
  };

  function seitePruefen(_, __, ergebnis) {
    const r = ergebnis || {};
    zeige(`${r.daten ? `<div class="karte hervor">
        <div class="meldung ok" style="margin-bottom:12px">Gültig — Modul ${esc(r.modul.name)}, ${esc(r.daten.kunde)}, ${r.daten.bis === UNBEGRENZT ? "unbefristet" : "bis " + de(r.daten.bis)}${r.daten.db ? ", nur Datenbank " + esc(r.daten.db) : ""}</div>
        ${daten.lizenzen.some((l) => l.schluessel === r.text) ? `<p class="klein" style="margin:0">Steht bereits in der Lizenzliste.</p>` : `
        <form data-aktion="uebernehmen" class="reihe" style="align-items:center">
          <span class="klein" style="flex:2">Außerhalb des Portals erstellt (z. B. Masterkey)? Übernehmen, damit der Ablauf im Blick bleibt.</span>
          <span class="segment" style="flex:0 0 auto">${Object.entries(ARTEN).map(([w, n]) => `<input type="radio" name="art" id="u-${w}" value="${w}" ${w === "kunde" ? "checked" : ""}><label for="u-${w}">${n}</label>`).join("")}</span>
          <span style="flex:0 0 auto"><button class="zweit">Übernehmen</button></span></form>`}
      </div>` : r.fehler ? `<div class="meldung fehler">${r.modul ? "Modul " + esc(r.modul.name) + ": " : ""}${esc(r.fehler)}</div>` : ""}
      <div class="karte">
        <h1>Schlüssel prüfen</h1>
        <p class="unter">Erkennt das Modul automatisch und prüft Signatur und Ablaufdatum — genau wie das Modul beim Kunden.</p>
        <form data-aktion="pruefen">
          <label for="schluessel">Lizenzschlüssel</label>
          <textarea id="schluessel" name="schluessel" rows="4" required>${esc(r.text || "")}</textarea>
          <details style="margin-top:12px"><summary>Datenbank-Bindung mitprüfen</summary>
            <label for="db">Odoo database.uuid</label><input id="db" name="db" value="${esc(r.db || "")}"></details>
          <p style="margin-top:20px;margin-bottom:0"><button>Prüfen</button></p>
        </form>
      </div>`);
  }

  let pruefErgebnis = null;
  aktionen.pruefen = async (w) => {
    pruefErgebnis = { text: w.schluessel, db: w.db };
    try {
      const [m, d] = await pruefeAlle(w.schluessel, w.db || null);
      pruefErgebnis.modul = m;
      if (d instanceof Error) pruefErgebnis.fehler = d.message; else pruefErgebnis.daten = d;
    } catch (e) {
      pruefErgebnis.fehler = e.message;
    }
    seitePruefen(null, null, pruefErgebnis);
  };

  aktionen.uebernehmen = async (w) => {
    const r = pruefErgebnis;
    if (!r || !r.daten) return;
    const art = ARTEN[w.art] ? w.art : "kunde";
    await aendern((d) => {
      if (d.lizenzen.some((l) => l.schluessel === r.text)) return;
      let k = d.kunden.find((x) => x.name === r.daten.kunde);
      if (!k) { k = { id: naechsteId(d.kunden), name: r.daten.kunde, erstellt_von: ich(), erstellt_am: jetzt() }; d.kunden.push(k); }
      d.lizenzen.push({ id: naechsteId(d.lizenzen), modul: r.modul.code, kunde_id: k.id, kunde: k.name, datenbank: "", von: heute(),
        bis: r.daten.bis, db: r.daten.db || null, notiz: "nachträglich übernommen", schluessel: r.text, erstellt_von: ich(), erstellt_am: jetzt(), art });
    }, `Lizenz übernommen: ${r.daten.kunde}`);
    meldung(`„${r.daten.kunde}“ (${r.modul.name}) übernommen.`);
    location.hash = "#/lizenzen";
  };

  function seiteModule(teile) {
    if (teile[0]) return seiteModul(teile[0]);
    zeige(`<div class="karte">
        <h1>Module</h1>
        <p class="unter">Jedes Modul hat ein eigenes Schlüsselpaar. Ein goai-Schlüssel funktioniert also nie im BMD-Modul und umgekehrt.</p>
        <div class="tabelle"><table>
          <tr><th>Modul</th><th>Code</th><th>Fingerabdruck</th><th>Lizenzen</th><th></th></tr>
          ${daten.module.map((m) => `<tr>
            <td><b>${esc(m.name)}</b>${m.beschreibung ? `<br><span class="klein">${esc(m.beschreibung)}</span>` : ""}</td>
            <td><code>${esc(m.code)}</code></td>
            <td class="klein" style="font-family:ui-monospace,Menlo,monospace;white-space:nowrap">${fingerabdruecke[m.code] || ""}<br>${m.altformat ? "Altformat (ohne Modul-Feld)" : "Standard"}</td>
            <td>${daten.lizenzen.filter((l) => l.modul === m.code).length}</td>
            <td style="text-align:right"><a class="knopf zweit klein-k" href="#/module/${esc(m.code)}">Entwickler-Infos</a></td></tr>`).join("")}
        </table></div>
      </div>
      <div class="karte">
        <h2>Neues Modul anlegen</h2>
        <form data-aktion="modul-neu">
          <div class="raster">
            <div><label for="name" class="pflicht">Name</label><input id="name" name="name" required maxlength="60" placeholder="z. B. BMD Schnittstelle"></div>
            <div><label for="code" class="pflicht">Code <small>klein, ohne Leerzeichen — steht im Schlüssel</small></label>
              <input id="code" name="code" required maxlength="30" pattern="[a-z][a-z0-9_]{1,29}" placeholder="z. B. bmd"></div>
          </div>
          <label for="beschreibung">Beschreibung</label>
          <input id="beschreibung" name="beschreibung" maxlength="200" placeholder="z. B. Buchhaltungsexport nach BMD NTCS">
          <label for="passwort" class="pflicht">Dein Passwort <small>zum Speichern des neuen Schlüssels im Tresor</small></label>
          <input id="passwort" name="passwort" type="password" required autocomplete="current-password">
          <p style="margin-bottom:0;margin-top:20px"><button>Modul anlegen</button></p>
        </form>
      </div>`);
  }

  aktionen["modul-neu"] = async (w) => {
    const code = (w.code || "").toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,29}$/.test(code)) throw new LF("Code: 2–30 Zeichen, nur a–z, 0–9 und _, beginnt mit einem Buchstaben.");
    if (modul(code)) throw new LF(`Modul „${code}“ gibt es schon.`);
    const geprueft = await Krypto.tresorOeffnen(daten.tresor, w.passwort);  // Passwort bestätigen
    const paar = await Krypto.neuesPaar();
    const neu = { ...geprueft, ...schluessel, [code]: paar.privat };
    const tresor = await Krypto.tresorSchliessen(neu, w.passwort);
    await aendern((d) => {
      if (d.module.some((m) => m.code === code)) throw new LF(`Modul „${code}“ gibt es schon.`);
      d.module.push({ code, name: w.name, beschreibung: w.beschreibung, oeffentlich: paar.oeffentlich, altformat: false, erstellt_am: jetzt() });
      d.tresor = tresor;
    }, `Modul ${w.name} angelegt`);
    schluessel = neu;
    sitzungSpeichern();
    await fingerabdrueckeNeu();
    meldung(`Modul „${w.name}“ angelegt — eigenes Schlüsselpaar erzeugt.`);
    location.hash = `#/module/${code}`;
  };

  async function seiteModul(code) {
    const m = modul(code);
    if (!m) { zeige(`<div class="karte"><h1>Modul nicht gefunden</h1></div>`); return; }
    const fp = fingerabdruecke[m.code];
    const beispiel = schluessel[m.code] ? await Krypto.erzeuge(schluessel[m.code], "Beispiel GmbH", UNBEGRENZT, m.altformat ? null : m.code) : "";
    zeige(`<p><a href="#/module">← Alle Module</a></p>
      <div class="karte hervor">
        <h1>${esc(m.name)} <span class="klein" style="font-size:16px">· Entwickler-Infos</span></h1>
        <p class="unter">Alles, was die Entwicklung braucht, damit das Modul Lizenzschlüssel aus diesem Portal prüft.</p>
        <p class="reihe" style="gap:10px">
          <span style="flex:0 0 auto"><button type="button" data-klick="pruefcode" data-code="${esc(m.code)}">lizenz_pruefung.py herunterladen</button></span>
          <span style="flex:0 0 auto"><button type="button" class="zweit" data-klick="anleitung" data-code="${esc(m.code)}">Anleitung (ENTWICKLER_${esc(m.code)}.md)</button></span>
        </p>
        <p class="klein">Beides an die Entwicklung weitergeben. Enthält nur den öffentlichen Schlüssel — damit kann man prüfen, aber keine Schlüssel erzeugen.</p>
      </div>
      <div class="karte">
        <h2>Fingerabdruck</h2>
        <p class="klein">Eindeutiges Kennzeichen des Schlüsselpaars. Steht auch im Prüfcode des Moduls: Stimmen beide überein, passen Portal und Modul zusammen.</p>
        <div class="schluessel" style="font-size:16px;letter-spacing:.04em;border-style:solid">${fp}</div>
        <h2 style="margin-top:20px">Öffentlicher Schlüssel</h2>
        <div class="schluessel" id="pub">${esc(m.oeffentlich)}</div>
        <p><button type="button" class="zweit klein-k" data-kopieren="pub">Kopieren</button></p>
        ${beispiel ? `<h2 style="margin-top:20px">Beispiel-Schlüssel zum Testen</h2>
        <p class="klein">„Beispiel GmbH“, unbefristet. Wird nicht gespeichert. Nur für Entwicklung und Tests weitergeben.</p>
        <div class="schluessel" id="beispiel">${esc(beispiel)}</div>
        <p style="margin-bottom:0"><button type="button" class="zweit klein-k" data-kopieren="beispiel">Kopieren</button></p>` : ""}
      </div>
      <div class="karte">
        <h2>Privaten Schlüssel sichern</h2>
        <p class="klein">Der private Schlüssel liegt verschlüsselt im Daten-Repo (Tresor). Zusätzlich im Passwort-Manager ablegen, Eintrag z. B. „E&amp;P Lizenz-Portal · ${esc(m.name)} · ${fp}“.</p>
        <div id="privat-bereich"><button type="button" class="gefahr" data-klick="privat-zeigen" data-code="${esc(m.code)}">Privaten Schlüssel anzeigen</button></div>
      </div>`);
  }

  function seiteEinstellungen() {
    const p = pflicht();
    const g = Speicher.geraet();
    zeige(`<div class="karte">
        <h1>Einstellungen</h1>
        <form data-aktion="pflicht">
          <h2>Pflichtfelder</h2>
          <p class="klein">Beim Ausstellen und beim Bearbeiten von Kunden. Der Firmenname ist immer Pflicht.</p>
          ${Object.entries(PFLICHT_FELDER).map(([f, n]) => `<label class="check"><input type="checkbox" name="p_${f}" value="1" ${p.has(f) ? "checked" : ""}> ${n}</label>`).join("")}
          <p style="margin-bottom:0"><button>Speichern</button></p>
        </form>
      </div>
      <div class="karte" style="max-width:520px">
        <h2>Passwort ändern</h2>
        <p class="klein">Gilt für alle, die sich am Portal anmelden.</p>
        <form data-aktion="passwort">
          <label for="alt">Aktuelles Passwort</label><input id="alt" name="alt" type="password" required autocomplete="current-password">
          <label for="neu">Neues Passwort <small>min. ${MIN_PASSWORT} Zeichen</small></label><input id="neu" name="neu" type="password" minlength="${MIN_PASSWORT}" required autocomplete="new-password">
          <label for="neu2">Neues Passwort wiederholen</label><input id="neu2" name="neu2" type="password" minlength="${MIN_PASSWORT}" required autocomplete="new-password">
          <p style="margin-bottom:0;margin-top:20px"><button>Passwort ändern</button></p>
        </form>
      </div>
      <div class="karte">
        <h2>Dieses Gerät</h2>
        <p class="klein">Name: <b>${esc(g.name)}</b> · Daten-Repo: <code>${esc(g.repo)}</code></p>
        <p class="reihe" style="gap:10px;margin-bottom:0">
          <span style="flex:0 0 auto"><button type="button" class="zweit" data-klick="sicherung">Sicherung herunterladen (JSON)</button></span>
          <span style="flex:0 0 auto"><button type="button" class="zweit" data-klick="geraet-neu">Token oder Name ändern</button></span>
          <span style="flex:0 0 auto"><button type="button" class="gefahr" data-klick="geraet-vergessen">Gerät abmelden und Token löschen</button></span>
        </p>
      </div>`);
  }

  aktionen.pflicht = async (w) => {
    const liste = Object.keys(PFLICHT_FELDER).filter((f) => w["p_" + f]);
    await aendern((d) => { d.einstellungen = { ...(d.einstellungen || {}), pflicht: liste }; }, "Einstellungen geändert");
    meldung("Einstellungen gespeichert.");
  };

  aktionen.passwort = async (w) => {
    if (w.neu.length < MIN_PASSWORT || w.neu !== w.neu2) throw new LF(`Neues Passwort: mindestens ${MIN_PASSWORT} Zeichen, beide gleich.`);
    const inhalt = await Krypto.tresorOeffnen(daten.tresor, w.alt);
    const tresor = await Krypto.tresorSchliessen(inhalt, w.neu);
    await aendern((d) => { d.tresor = tresor; }, "Passwort geändert");
    meldung("Passwort geändert. Ab jetzt mit dem neuen Passwort anmelden.");
    seiteEinstellungen();
  };

  // ---------- Klicks ----------

  const klicks = {
    "geraet-neu": () => { $("#kopf").hidden = true; seiteGeraet(); },
    "geraet-vergessen": async () => {
      if (!(await bestaetigen("Gerät abmelden?", "Token und Name werden aus diesem Browser gelöscht. Die Daten auf GitHub bleiben erhalten.", "OK, abmelden"))) return;
      Speicher.geraetVergessen();
      abmelden();
    },
    csv: () => {
      const spalten = ["modul", "art", "kunde", "ansprechpartner", "telefon", "email", "adresse", "datenbank", "von", "bis", "notiz", "erstellt_von", "erstellt_am", "schluessel"];
      const sicher = (v) => { const s = String(v == null ? "" : v); return /^[=+\-@]/.test(s) ? "'" + s : s; };
      const zelle = (v) => `"${sicher(v).replace(/"/g, '""')}"`;
      const zeilen = daten.lizenzen.map((l) => { const k = kunde(l.kunde_id) || {}; return spalten.map((s) => zelle(s in l ? l[s] : k[s])).join(";"); });
      herunterladen("lizenzen.csv", "﻿" + [spalten.join(";"), ...zeilen].join("\r\n"), "text/csv");
    },
    sicherung: () => herunterladen(`lizenz-portal-sicherung-${heute()}.json`, JSON.stringify(daten, null, 1), "application/json"),
    pruefcode: (el) => { const m = modul(el.dataset.code); herunterladen("lizenz_pruefung.py", Entwickler.pruefcode(m, fingerabdruecke[m.code]), "text/x-python"); },
    anleitung: (el) => { const m = modul(el.dataset.code); herunterladen(`ENTWICKLER_${m.code}.md`, Entwickler.anleitung(m, fingerabdruecke[m.code]), "text/markdown"); },
    "privat-zeigen": async (el) => {
      const m = modul(el.dataset.code);
      if (!(await bestaetigen("Privaten Schlüssel anzeigen?", `Wer diesen Schlüssel kennt, kann beliebige gültige ${m.name}-Lizenzen erzeugen. Nur anzeigen, um ihn im Passwort-Manager zu sichern.`, "OK, anzeigen"))) return;
      $("#privat-bereich").innerHTML = `<div class="meldung fehler" style="margin-bottom:10px">Geheim! Nur in den Passwort-Manager kopieren, nie per E-Mail, Chat oder in ein Repo.</div>
        <div class="schluessel" id="privat" style="border-color:var(--err)">${esc(schluessel[m.code] || "nicht im Tresor")}</div>
        <p style="margin-bottom:0"><button type="button" class="gefahr klein-k" data-kopieren="privat">Kopieren</button>
        <button type="button" class="zweit klein-k" data-klick="privat-weg">Ausblenden</button></p>`;
    },
    "privat-weg": () => route(),
    "lizenz-loeschen": async (el) => {
      const id = Number(el.dataset.id);
      const l = daten.lizenzen.find((x) => x.id === id);
      if (!l) return;
      const text = `${modul(l.modul)?.name || l.modul}-Lizenz für „${l.kunde}“${l.datenbank ? ` (${l.datenbank})` : ""}, gültig bis ${de(l.bis)}, wird aus dem Portal gelöscht. Hinweis: Der Schlüssel selbst funktioniert beim Kunden weiter, bis er abläuft.`;
      if (!(await bestaetigen("Lizenz wirklich löschen?", text))) return;
      await aendern((d) => { d.lizenzen = d.lizenzen.filter((x) => x.id !== id); }, `Lizenz gelöscht: ${l.kunde}`);
      meldung(`Lizenz für „${l.kunde}“ gelöscht.`);
      route();
    },
    "kunde-loeschen": async (el) => {
      const id = Number(el.dataset.id);
      const k = kunde(id);
      const n = daten.lizenzen.filter((l) => l.kunde_id === id).length;
      if (n) { meldung(`„${k.name}“ hat noch ${n} Lizenz(en). Erst die Lizenzen löschen.`, "fehler"); return; }
      if (!(await bestaetigen("Kunde wirklich löschen?", `„${k.name}“ wird mit allen Kontaktdaten gelöscht.`))) return;
      await aendern((d) => { d.kunden = d.kunden.filter((x) => x.id !== id); }, `Kunde gelöscht: ${k.name}`);
      meldung(`Kunde „${k.name}“ gelöscht.`);
      location.hash = "#/kunden";
    },
  };

  // ---------- Ereignisse ----------

  document.addEventListener("submit", async (ev) => {
    const form = ev.target.closest("form[data-aktion]");
    if (!form) return;
    ev.preventDefault();
    const knopf = $("button:not([type=button])", form);
    if (knopf) knopf.disabled = true;
    try {
      await aktionen[form.dataset.aktion](formWerte(form), form);
    } catch (e) {
      meldung(e instanceof LF || e instanceof Error ? e.message : String(e), "fehler");
    } finally {
      if (knopf && document.contains(knopf)) knopf.disabled = false;
    }
  });

  document.addEventListener("click", async (ev) => {
    const kopie = ev.target.closest("[data-kopieren]");
    if (kopie) {
      const el = document.getElementById(kopie.dataset.kopieren);
      await navigator.clipboard.writeText((el.value !== undefined ? el.value : el.innerText).trim());
      const alt = kopie.textContent;
      kopie.textContent = "Kopiert ✓";
      setTimeout(() => { kopie.textContent = alt; }, 1500);
      return;
    }
    const k = ev.target.closest("[data-klick]");
    if (k && klicks[k.dataset.klick]) {
      ev.preventDefault();
      try { await klicks[k.dataset.klick](k); } catch (e) { meldung(e.message, "fehler"); }
    }
  });

  document.addEventListener("change", (ev) => {
    if (ev.target.closest("#formular")) {
      if (ev.target.id === "art-test") $("#lz-t30").checked = true;
      ausstellenSichtbar();
    }
    if (ev.target.matches("#filter-art, #filter-modul")) filtern();
  });

  document.addEventListener("input", (ev) => {
    if (ev.target.id === "suche") filtern();
  });

  $("#abmelden").addEventListener("click", abmelden);
  window.addEventListener("hashchange", route);
  start();
})();
