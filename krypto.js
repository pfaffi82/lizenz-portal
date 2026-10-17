/* E&P Lizenz-Portal — Kryptografie im Browser (WebCrypto).
 *
 * Lizenzschlüssel: base64url(JSON-Bytes) + "." + base64url(Ed25519-Signatur über diese Bytes)
 *   goai (Altformat): {"kunde": "…", "bis": "JJJJ-MM-TT"}   — exakt wie Pythons json.dumps
 *   neue Module:      {"bis":"…","kunde":"…","modul":"code"[,"db":"…"]} — kompakt, sortiert
 * Tresor: private Schlüssel, verschlüsselt mit AES-256-GCM, Schlüssel per PBKDF2-SHA256 aus dem Passwort.
 */
"use strict";

const Krypto = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const PKCS8_ED25519 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  const TRESOR_RUNDEN = 600000;

  class LizenzFehler extends Error {}

  function b64e(bytes) {
    let s = "";
    new Uint8Array(bytes).forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64d(text) {
    const t = String(text).trim().replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]*$/.test(t)) throw new LizenzFehler("ungültige Zeichen");
    const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  async function privatImport(seedText) {
    const seed = b64d(seedText);
    if (seed.length !== 32) throw new LizenzFehler("Privater Schlüssel muss 32 Byte (base64url) sein.");
    const pkcs8 = new Uint8Array(48);
    pkcs8.set(PKCS8_ED25519);
    pkcs8.set(seed, 16);
    return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  }

  async function oeffentlichAus(seedText) {
    const jwk = await crypto.subtle.exportKey("jwk", await privatImport(seedText));
    return jwk.x;
  }

  async function neuesPaar() {
    const paar = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", paar.privateKey));
    const roh = await crypto.subtle.exportKey("raw", paar.publicKey);
    return { privat: b64e(pkcs8.slice(-32)), oeffentlich: b64e(roh) };
  }

  async function fingerabdruck(oeffentlich) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b64d(oeffentlich)));
    const hex = Array.from(h.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    return hex.match(/.{4}/g).join(" ");
  }

  // Wie Pythons json.dumps(str) mit ensure_ascii=True
  function pyStr(s) {
    return JSON.stringify(s).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }

  function datenBytes(kunde, bis, modul, dbUuid) {
    if (!modul) return enc.encode(`{"kunde": ${pyStr(kunde)}, "bis": ${pyStr(bis)}}`);
    const daten = { bis, kunde, modul };
    if (dbUuid) daten.db = dbUuid.trim().toLowerCase();
    const sortiert = {};
    Object.keys(daten).sort().forEach((k) => { sortiert[k] = daten[k]; });
    return enc.encode(JSON.stringify(sortiert));
  }

  async function erzeuge(seedText, kunde, bis, modul, dbUuid) {
    kunde = (kunde || "").trim();
    if (!kunde) throw new LizenzFehler("Kundenname fehlt.");
    const roh = datenBytes(kunde, bis, modul, dbUuid && dbUuid.trim() ? dbUuid : null);
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, await privatImport(seedText), roh);
    return b64e(roh) + "." + b64e(sig);
  }

  function heuteISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function datumDE(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || "");
  }

  async function pruefe(schluessel, oeffentlich, modul, dbUuid, heute) {
    const teile = String(schluessel || "").trim().split(".");
    if (teile.length !== 2) throw new LizenzFehler("Kein gültiges Lizenzformat (erwartet <daten>.<signatur>).");
    let roh;
    try {
      roh = b64d(teile[0]);
      const pub = await crypto.subtle.importKey("raw", b64d(oeffentlich), { name: "Ed25519" }, false, ["verify"]);
      const ok = await crypto.subtle.verify({ name: "Ed25519" }, pub, b64d(teile[1]), roh);
      if (!ok) throw new Error("sig");
    } catch (e) {
      throw new LizenzFehler("Signatur ungültig — Schlüssel wurde verändert oder gehört zu einem anderen Modul.");
    }
    let daten;
    try {
      daten = JSON.parse(dec.decode(roh));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(daten.bis)) throw new Error("bis");
    } catch (e) {
      throw new LizenzFehler("Lizenzdaten nicht lesbar.");
    }
    if (modul && daten.modul !== modul) throw new LizenzFehler("Schlüssel gehört zu einem anderen Modul.");
    if ((heute || heuteISO()) > daten.bis) throw new LizenzFehler(`Lizenz abgelaufen am ${datumDE(daten.bis)}.`);
    if (daten.db && dbUuid && daten.db !== dbUuid.trim().toLowerCase()) throw new LizenzFehler("Lizenz gilt für eine andere Odoo-Datenbank.");
    return daten;
  }

  // ---------- Tresor ----------

  async function tresorSchluessel(passwort, salt, runden) {
    const basis = await crypto.subtle.importKey("raw", enc.encode(passwort), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: runden },
      basis, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function tresorSchliessen(inhalt, passwort) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await tresorSchluessel(passwort, salt, TRESOR_RUNDEN);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(JSON.stringify(inhalt)));
    return { v: 1, runden: TRESOR_RUNDEN, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
  }

  async function tresorOeffnen(tresor, passwort) {
    try {
      const k = await tresorSchluessel(passwort, b64d(tresor.salt), tresor.runden);
      const klar = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(tresor.iv) }, k, b64d(tresor.ct));
      return JSON.parse(dec.decode(klar));
    } catch (e) {
      throw new LizenzFehler("Passwort falsch.");
    }
  }

  async function unterstuetzt() {
    try {
      await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      return true;
    } catch (e) {
      return false;
    }
  }

  return { LizenzFehler, b64e, b64d, oeffentlichAus, neuesPaar, fingerabdruck, erzeuge, pruefe,
           tresorSchliessen, tresorOeffnen, heuteISO, datumDE, unterstuetzt };
})();
