/* E&P Lizenz-Portal — Daten in einem privaten GitHub-Repo (daten.json) über die GitHub-API.
 * Das GitHub-Token liegt nur im Browser dieses Geräts (localStorage), nie im Code.
 */
"use strict";

const Speicher = (() => {
  const GERAET = "eps-lizenz-geraet";
  const DATEI = "daten.json";
  let sha = null;

  function geraet() {
    try { return JSON.parse(localStorage.getItem(GERAET)) || null; } catch (e) { return null; }
  }

  function geraetSpeichern(werte) {
    localStorage.setItem(GERAET, JSON.stringify(werte));
  }

  function geraetVergessen() {
    try { localStorage.removeItem(GERAET); } catch (e) { /* egal */ }
  }

  async function api(methode, body) {
    const g = geraet();
    const antwort = await fetch(`https://api.github.com/repos/${g.repo}/contents/${DATEI}`, {
      method: methode,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${g.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return antwort;
  }

  function utf8ZuB64(text) {
    const bytes = new TextEncoder().encode(text);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /** Lädt daten.json. Gibt null zurück, wenn es die Datei noch nicht gibt. */
  async function laden() {
    const r = await api("GET");
    if (r.status === 404) {
      const repo = await fetch(`https://api.github.com/repos/${geraet().repo}`, {
        headers: { Authorization: `Bearer ${geraet().token}` },
      });
      if (repo.status === 404) throw new Error(`Repo ${geraet().repo} nicht gefunden oder Token hat keinen Zugriff.`);
      sha = null;
      return null;
    }
    if (r.status === 401) throw new Error("GitHub-Token ungültig oder abgelaufen.");
    if (!r.ok) throw new Error(`GitHub antwortet mit Fehler ${r.status}.`);
    const j = await r.json();
    sha = j.sha;
    const bin = atob(j.content.replace(/\n/g, ""));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  }

  /** Speichert daten.json. Wirft "Konflikt", wenn jemand anderes zwischenzeitlich gespeichert hat. */
  async function speichern(daten, nachricht) {
    const r = await api("PUT", {
      message: nachricht || "Lizenz-Portal: Daten aktualisiert",
      content: utf8ZuB64(JSON.stringify(daten, null, 1)),
      ...(sha ? { sha } : {}),
    });
    if (r.status === 409 || r.status === 422) throw new Error("Konflikt");
    if (r.status === 403) throw new Error("Token darf nicht schreiben (Berechtigung „Contents: Read and write“ fehlt).");
    if (!r.ok) throw new Error(`Speichern fehlgeschlagen (GitHub-Fehler ${r.status}).`);
    sha = (await r.json()).content.sha;
  }

  return { geraet, geraetSpeichern, geraetVergessen, laden, speichern };
})();
