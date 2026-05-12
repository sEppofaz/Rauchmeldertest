'use strict';

const DROPBOX_JSON_PATH = '/Apps/Claude/Messdaten/rauchmelder.json';
const APP_KEY           = 's2ggv6zysmzn7fa';
const APP_VERSION       = 'v1';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const AUTH_URL  = 'https://www.dropbox.com/oauth2/authorize';
const CONTENT   = 'https://content.dropboxapi.com/2';

// ── Dropbox Auth (PKCE) ─────────────────────────────────────────

function b64url(buf) {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function pkce() {
  const v = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return { verifier: v, challenge: b64url(new Uint8Array(d)) };
}
function canonicalUrl() {
  const u = new URL(location.href);
  u.search = ''; u.hash = '';
  if (u.pathname.endsWith('index.html')) u.pathname = u.pathname.slice(0, -10);
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.href;
}
async function startAuth() {
  const ru = canonicalUrl();
  const { verifier, challenge } = await pkce();
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('redirect_uri', ru);
  location.href = AUTH_URL + '?' + new URLSearchParams({
    response_type: 'code', client_id: APP_KEY, redirect_uri: ru,
    code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline',
  });
}
async function handleCallback() {
  const code = new URLSearchParams(location.search).get('code');
  if (!code) return;
  const verifier = sessionStorage.getItem('pkce_verifier');
  const ru = sessionStorage.getItem('redirect_uri') || canonicalUrl();
  if (!verifier) { alert('Auth-Fehler: Sitzungsdaten fehlen.'); history.replaceState({}, '', location.pathname); return; }
  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: APP_KEY, redirect_uri: ru, code_verifier: verifier }),
    });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    localStorage.setItem('dropbox_access_token', d.access_token);
    localStorage.setItem('dropbox_refresh_token', d.refresh_token);
    localStorage.setItem('dropbox_expires', Date.now() + d.expires_in * 1000);
  } catch (e) { alert('Token-Fehler: ' + e.message); }
  history.replaceState({}, '', location.pathname);
}
function isConnected() { return !!localStorage.getItem('dropbox_refresh_token'); }
function disconnect() {
  ['dropbox_access_token', 'dropbox_refresh_token', 'dropbox_expires'].forEach(k => localStorage.removeItem(k));
  _data = null; init();
}
async function getToken() {
  const exp = +localStorage.getItem('dropbox_expires');
  if (Date.now() < exp - 60_000) return localStorage.getItem('dropbox_access_token');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: localStorage.getItem('dropbox_refresh_token'), client_id: APP_KEY }),
  });
  if (!r.ok) throw new Error('Token abgelaufen – bitte neu verbinden.');
  const d = await r.json();
  localStorage.setItem('dropbox_access_token', d.access_token);
  localStorage.setItem('dropbox_expires', Date.now() + d.expires_in * 1000);
  return d.access_token;
}
async function applyUpdate() {
  if ('caches' in window) await Promise.all((await caches.keys()).map(k => caches.delete(k)));
  if ('serviceWorker' in navigator) await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r => r.unregister()));
  location.reload(true);
}

// ── Dropbox I/O ─────────────────────────────────────────────────

async function jsonDownload(token) {
  const r = await fetch(CONTENT + '/files/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_JSON_PATH }) },
  });
  if (r.status === 409) return null;
  if (!r.ok) { let d; try { d = (await r.json()).error_summary; } catch { d = r.status; } throw new Error('Dropbox ' + d); }
  return r.json();
}
async function jsonUpload(token, data) {
  const r = await fetch(CONTENT + '/files/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_JSON_PATH, mode: 'overwrite', autorename: false }) },
    body: new TextEncoder().encode(JSON.stringify(data)),
  });
  if (!r.ok) throw new Error('Upload fehlgeschlagen: ' + r.status);
}

// ── Helpers ─────────────────────────────────────────────────────

function fmtDate(s) {
  if (!s) return '–';
  const [y, m, d] = s.split('-');
  return `${d}.${m}.${y}`;
}
function today() { return new Date().toISOString().slice(0, 10); }
function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  return (Date.now() - new Date(dateStr).getTime()) / 86400000;
}
function uid() { return Math.random().toString(36).slice(2, 10); }
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Ampel-Logik ──────────────────────────────────────────────────

function ampelStatus(geraet, pruefungen) {
  const heute = today();
  // Gerät abgelaufen?
  if (geraet.ablauf && geraet.ablauf < heute) return 'rot';

  // Letzte Prüfung
  const ps = pruefungen.filter(p => p.geraet_id === geraet.id).sort((a, b) => a.datum < b.datum ? 1 : -1);
  if (!ps.length) return 'rot';

  const last = ps[0];
  if (last.ergebnis === 'defekt' || last.ergebnis === 'gesperrt') return 'rot';

  const days = daysSince(last.datum);
  if (days <= 366) return 'gruen';
  if (days <= 730) return 'gelb';
  return 'rot';
}

function ampelLabel(status) {
  return { gruen: '✓ OK', gelb: '! Prüfen', rot: '✗ Überfällig' }[status] ?? '';
}

// ── State ────────────────────────────────────────────────────────

let tabIdx = 0;
let _data  = null;
let detailGeraetId = null;
let editGeraetId   = null;
let selectedErgebnis = 'ok';
let showArchiv = false;

function emptyData() { return { v: 1, geraete: [], pruefungen: [] }; }

async function loadData() {
  const token = await getToken();
  _data = await jsonDownload(token) || emptyData();
  if (!_data.pruefungen) _data.pruefungen = [];
  return _data;
}
async function saveData() {
  const token = await getToken();
  await jsonUpload(token, _data);
}

// ── Setup ────────────────────────────────────────────────────────

function renderSetup() {
  document.getElementById('root').innerHTML = `
    <div class="setup">
      <div class="setup-icon"><img src="icon.svg" alt="Rauchmelder"></div>
      <h1>Rauchmelder</h1>
      <p>Einmalig mit Dropbox verbinden,<br>danach öffnet die App direkt.</p>
      <button class="btn-primary" style="width:100%;max-width:320px" onclick="startAuth()">
        Mit Dropbox verbinden →
      </button>
    </div>`;
}

// ── App-Shell ────────────────────────────────────────────────────

function renderApp() {
  document.getElementById('root').innerHTML = `
    <div id="app">
      <div class="app-header">
        <img src="icon.svg" alt="">
        <span class="app-header-title">Rauchmelder</span>
      </div>
      <div class="tab-bar" id="tab-bar"></div>
      <div class="scroll" id="scroll"></div>
    </div>`;
  renderTabBar();
  renderTab();
}

function renderTabBar() {
  const tabs = ['🏠 Geräte', '✅ Prüfung'];
  document.getElementById('tab-bar').innerHTML = tabs.map((t, i) =>
    `<button class="tab-btn${i === tabIdx ? ' active' : ''}" onclick="switchTab(${i})">${t}</button>`
  ).join('');
}

function switchTab(i) { tabIdx = i; renderTabBar(); renderTab(); }

function renderTab() {
  if (tabIdx === 0) renderGeraete();
  else renderPruefungForm();
}

// ── Tab 1: Geräteliste ───────────────────────────────────────────

function geraetItemHtml(g) {
  const status = ampelStatus(g, _data.pruefungen);
  const ps = _data.pruefungen.filter(p => p.geraet_id === g.id).sort((a, b) => a.datum < b.datum ? 1 : -1);
  const lastDatum = ps[0]?.datum ?? null;
  const lastErg   = ps[0]?.ergebnis ?? null;
  const meta = lastDatum
    ? `${fmtDate(lastDatum)} · ${lastErg ?? '?'}${g.ablauf ? ' · Ablauf ' + fmtDate(g.ablauf) : ''}`
    : `Noch nie geprüft${g.ablauf ? ' · Ablauf ' + fmtDate(g.ablauf) : ''}`;
  return `<div class="geraet-item" onclick="showDetail('${esc(g.id)}')">
    <div class="ampel ampel-${status}"></div>
    <div class="geraet-info">
      <div class="geraet-name">${esc(g.name)}</div>
      <div class="geraet-meta">${esc(meta)}</div>
    </div>
    <div class="geraet-arrow">›</div>
  </div>`;
}

function renderGeraete() {
  const scroll = document.getElementById('scroll');
  if (!_data) { scroll.innerHTML = '<p style="padding:20px;color:var(--label)">Lade…</p>'; loadData().then(renderGeraete); return; }

  const aktiv     = _data.geraete.filter(g => !g.archiviert);
  const archiviert = _data.geraete.filter(g => g.archiviert);
  const orte = [...new Set(aktiv.map(g => g.ort))];
  let html = '';

  // Zusammenfassung (nur aktive Geräte)
  const rot   = aktiv.filter(g => ampelStatus(g, _data.pruefungen) === 'rot').length;
  const gelb  = aktiv.filter(g => ampelStatus(g, _data.pruefungen) === 'gelb').length;
  const gruen = aktiv.filter(g => ampelStatus(g, _data.pruefungen) === 'gruen').length;
  html += `<div class="card" style="display:flex;gap:16px;justify-content:center;text-align:center">
    <div><div style="font-size:22px;font-weight:700;color:var(--green)">${gruen}</div><div style="font-size:11px;color:var(--label)">OK</div></div>
    <div><div style="font-size:22px;font-weight:700;color:var(--yellow)">${gelb}</div><div style="font-size:11px;color:var(--label)">Prüfen</div></div>
    <div><div style="font-size:22px;font-weight:700;color:var(--danger)">${rot}</div><div style="font-size:11px;color:var(--label)">Überfällig</div></div>
    <div><div style="font-size:22px;font-weight:700;color:var(--text)">${aktiv.length}</div><div style="font-size:11px;color:var(--label)">Aktiv</div></div>
  </div>`;

  // Aktive Geräte nach Ort
  for (const ort of orte) {
    const geraete = aktiv.filter(g => g.ort === ort);
    html += `<div class="section-title">${esc(ort)}</div><div class="card" style="padding:0 16px">`;
    for (const g of geraete) html += geraetItemHtml(g);
    html += '</div>';
  }

  // Neues Gerät
  html += `<div class="card">
    <button class="btn-primary" onclick="showEditGeraet(null)">+ Neues Gerät eintragen</button>
  </div>`;

  // Archiv
  if (archiviert.length) {
    html += `<button class="link-btn" style="display:block;width:100%;text-align:left;padding:8px 4px;color:var(--label)"
      onclick="showArchiv=!showArchiv;renderGeraete()">
      📦 Archiv (${archiviert.length} Gerät${archiviert.length > 1 ? 'e' : ''}) ${showArchiv ? '▲' : '▼'}
    </button>`;
    if (showArchiv) {
      const archivOrte = [...new Set(archiviert.map(g => g.ort))];
      for (const ort of archivOrte) {
        const geraete = archiviert.filter(g => g.ort === ort);
        html += `<div class="section-title" style="color:var(--border)">${esc(ort)}</div>
          <div class="card" style="padding:0 16px;opacity:0.55">`;
        for (const g of geraete) html += geraetItemHtml(g);
        html += '</div>';
      }
    }
  }
  html += `<div class="footer-links">
    <button class="link-btn" onclick="applyUpdate()">🔄 Aktualisieren</button>
    <button class="link-btn danger" onclick="disconnect()">Dropbox trennen</button>
    <span class="app-version">${APP_VERSION}</span>
  </div>`;
  scroll.innerHTML = html;
}

// ── Detail-Overlay ───────────────────────────────────────────────

function showDetail(id) {
  detailGeraetId = id;
  renderDetailOverlay();
}

function renderDetailOverlay() {
  const g = _data.geraete.find(x => x.id === detailGeraetId);
  if (!g) return;

  const status = ampelStatus(g, _data.pruefungen);
  const ps = _data.pruefungen.filter(p => p.geraet_id === g.id).sort((a, b) => a.datum < b.datum ? 1 : -1);

  // Ablauf-Badge
  let ablaufHtml = '';
  if (g.ablauf) {
    const cls = g.ablauf < today() ? 'ablauf-danger' : daysSince(g.ablauf) > -180 ? 'ablauf-warn' : 'ablauf-ok';
    ablaufHtml = `<span class="ablauf-badge ${cls}">${g.ablauf < today() ? '⚠ Abgelaufen ' : ''}${fmtDate(g.ablauf)}</span>`;
  }

  // Stammdaten
  const rows = [
    ['Typ',          g.typ],
    ['Ort',          g.ort],
    ['Modell',       g.modell],
    ['Aktivierung',  g.aktivierung ? fmtDate(g.aktivierung) : null],
    ['Laufzeit',     g.laufzeit_jahre ? g.laufzeit_jahre + ' Jahre' : null],
    ['Ablauf',       g.ablauf ? `${fmtDate(g.ablauf)}` : null],
    ['Prüfmethode',  g.pruefmethode],
    ['Bemerkung',    g.bemerkung],
    ['Zusatzprüf.',  g.weitere_pruefungen],
  ].filter(([, v]) => v);

  const metaHtml = rows.map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td>${esc(v)}${k === 'Ablauf' && g.ablauf < today() ? ' ⚠' : ''}</td></tr>`
  ).join('');

  // Prüfhistorie
  const histHtml = ps.length ? ps.map(p => {
    const ergCls = p.ergebnis === 'ok' ? 'erg-ok' : p.ergebnis === 'Batterie leer' ? 'erg-warn' : 'erg-defekt';
    return `<div class="pruef-row">
      <div class="pruef-datum">${fmtDate(p.datum)}</div>
      <div class="pruef-erg ${ergCls}">${esc(p.ergebnis)}</div>
      ${p.bemerkung ? `<div class="pruef-bem">${esc(p.bemerkung)}</div>` : ''}
    </div>`;
  }).join('') : '<p style="color:var(--label);font-size:14px;padding:8px 0">Noch keine Prüfungen</p>';

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.id = 'detail-overlay';
  overlay.innerHTML = `
    <div class="overlay-header">
      <button class="back-btn" onclick="closeDetail()">‹ Zurück</button>
      <span class="overlay-title">${esc(g.name)}</span>
      <button class="edit-btn" onclick="showEditGeraet('${esc(g.id)}')">Bearbeiten</button>
    </div>
    <div class="overlay-scroll">
      <div class="card">
        <table class="meta-table">${metaHtml}</table>
      </div>
      <div class="section-title">Prüfhistorie (${ps.length})</div>
      <div class="card" style="padding:0 16px">${histHtml}</div>
      ${!g.archiviert ? `<div class="card">
        <button class="btn-primary" onclick="schnellPruefung('${esc(g.id)}')">✅ Neue Prüfung eintragen</button>
      </div>` : ''}
      <div class="card">
        <button class="btn-secondary" style="color:var(--label);font-size:15px"
          onclick="toggleArchivGeraet('${esc(g.id)}')">
          ${g.archiviert ? '🔄 Wiederherstellen' : '📦 Ins Archiv verschieben'}
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

function closeDetail() {
  document.getElementById('detail-overlay')?.remove();
  detailGeraetId = null;
}

async function toggleArchivGeraet(id) {
  const g = _data.geraete.find(x => x.id === id);
  if (!g) return;
  const wirdArchiviert = !g.archiviert;
  if (wirdArchiviert && !confirm(`„${g.name}" ins Archiv verschieben?`)) return;
  g.archiviert = wirdArchiviert || undefined;
  try {
    await saveData();
    closeDetail();
    if (wirdArchiviert) showArchiv = false;
    renderGeraete();
  } catch (e) {
    alert('Fehler: ' + e.message);
  }
}

// ── Schnell-Prüfung aus Detail ───────────────────────────────────

function schnellPruefung(id) {
  closeDetail();
  tabIdx = 1;
  selectedErgebnis = 'ok';
  renderTabBar();
  renderPruefungForm(id);
}

// ── Tab 2: Neue Prüfung ──────────────────────────────────────────

function renderPruefungForm(preselect) {
  const scroll = document.getElementById('scroll');
  if (!_data) { scroll.innerHTML = '<p style="padding:20px;color:var(--label)">Lade…</p>'; loadData().then(() => renderPruefungForm(preselect)); return; }

  // Gerät-Optionen gruppiert nach Ort
  const orte = [...new Set(_data.geraete.map(g => g.ort))];
  let optHtml = '<option value="">— Gerät wählen —</option>';
  for (const ort of orte) {
    optHtml += `<optgroup label="${esc(ort)}">`;
    for (const g of _data.geraete.filter(x => x.ort === ort)) {
      const sel = preselect === g.id ? ' selected' : '';
      optHtml += `<option value="${esc(g.id)}"${sel}>${esc(g.name)}</option>`;
    }
    optHtml += '</optgroup>';
  }

  scroll.innerHTML = `
    <div class="card">
      <div class="field-group">
        <label>Datum</label>
        <input type="date" id="f-datum" value="${today()}">
      </div>
      <div class="field-group">
        <label>Gerät <span class="req">*</span></label>
        <select id="f-geraet">${optHtml}</select>
      </div>
      <div class="field-group">
        <label>Ergebnis <span class="req">*</span></label>
        <div class="ergebnis-bar">
          <button class="ergebnis-chip${selectedErgebnis === 'ok' ? ' selected-ok' : ''}" onclick="setErgebnis('ok')">✓ OK</button>
          <button class="ergebnis-chip${selectedErgebnis === 'Batterie leer' ? ' selected-warn' : ''}" onclick="setErgebnis('Batterie leer')">🔋 Batterie leer</button>
          <button class="ergebnis-chip${selectedErgebnis === 'defekt' ? ' selected-defekt' : ''}" onclick="setErgebnis('defekt')">✗ Defekt</button>
          <button class="ergebnis-chip${selectedErgebnis === 'gesperrt' ? ' selected-defekt' : ''}" onclick="setErgebnis('gesperrt')">🚫 Gesperrt</button>
        </div>
      </div>
      <div class="field-group">
        <label>Bemerkung</label>
        <textarea id="f-bemerkung" class="auto-grow" rows="1" placeholder="optional"></textarea>
      </div>
      <button class="btn-primary" onclick="submitPruefung()">Prüfung speichern</button>
      <div class="status" id="status"></div>
    </div>
    <div class="footer-links">
      <button class="link-btn" onclick="applyUpdate()">🔄 Aktualisieren</button>
      <button class="link-btn danger" onclick="disconnect()">Dropbox trennen</button>
      <span class="app-version">${APP_VERSION}</span>
    </div>`;
}

function setErgebnis(val) {
  selectedErgebnis = val;
  // Chips neu rendern ohne Full-Rerender
  document.querySelectorAll('.ergebnis-chip').forEach(btn => {
    btn.className = 'ergebnis-chip';
    const t = btn.textContent.trim();
    if (val === 'ok' && t.startsWith('✓'))              btn.classList.add('selected-ok');
    if (val === 'Batterie leer' && t.startsWith('🔋'))  btn.classList.add('selected-warn');
    if (val === 'defekt' && t.startsWith('✗'))          btn.classList.add('selected-defekt');
    if (val === 'gesperrt' && t.startsWith('🚫'))       btn.classList.add('selected-defekt');
  });
}

async function submitPruefung() {
  const status = document.getElementById('status');
  const setS   = (msg, ok = true) => { if (status) { status.textContent = msg; status.className = 'status ' + (ok ? 'ok' : 'err'); } };

  const datum   = document.getElementById('f-datum')?.value;
  const geraetId = document.getElementById('f-geraet')?.value;
  if (!datum)    { setS('⚠️ Datum erforderlich', false); return; }
  if (!geraetId) { setS('⚠️ Gerät wählen', false); return; }

  const bem = document.getElementById('f-bemerkung')?.value.trim() ?? '';
  setS('⏳ Speichern…');
  try {
    if (!_data) await loadData();
    _data.pruefungen.push({ id: uid(), geraet_id: geraetId, datum, ergebnis: selectedErgebnis, bemerkung: bem || null });
    _data.pruefungen.sort((a, b) => a.datum < b.datum ? -1 : 1);
    await saveData();
    setS('✅ Prüfung gespeichert');
    document.getElementById('f-geraet').value = '';
    document.getElementById('f-bemerkung').value = '';
    selectedErgebnis = 'ok';
    setErgebnis('ok');
    // Geräteliste refresh
    if (tabIdx === 0) renderGeraete();
  } catch (e) {
    setS('❌ ' + e.message.slice(0, 100), false);
  }
}

// ── Gerät bearbeiten ─────────────────────────────────────────────

function showEditGeraet(id) {
  editGeraetId = id;
  const isNew = id === null;
  const g = isNew ? { ort: '', name: '', typ: 'Rauchmelder', modell: '', aktivierung: '', laufzeit_jahre: '', ablauf: '', pruefmethode: 'Funktionstaste', bemerkung: '' }
                  : _data.geraete.find(x => x.id === id);
  if (!g) return;

  const orte = [...new Set(_data.geraete.map(x => x.ort))];
  const ortOpts = orte.map(o => `<option${o === g.ort ? ' selected' : ''}>${esc(o)}</option>`).join('');
  const typOpts = ['Rauchmelder', 'Feuerlöscher', 'Löschdose'].map(t =>
    `<option${t === g.typ ? ' selected' : ''}>${t}</option>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'overlay edit-overlay';
  overlay.id = 'edit-overlay';
  overlay.innerHTML = `
    <div class="overlay-header">
      <button class="back-btn" onclick="closeEditGeraet()">‹ Zurück</button>
      <span class="overlay-title">${isNew ? 'Neues Gerät' : 'Gerät bearbeiten'}</span>
    </div>
    <div class="overlay-scroll">
      <div class="card">
        <div class="field-group"><label>Name</label>
          <input id="eg-name" type="text" value="${esc(g.name)}"></div>
        <div class="field-group"><label>Ort</label>
          <input id="eg-ort" type="text" value="${esc(g.ort)}" list="eg-ort-list">
          <datalist id="eg-ort-list">${ortOpts}</datalist></div>
        <div class="field-group"><label>Typ</label>
          <select id="eg-typ">${typOpts}</select></div>
        <div class="field-group"><label>Modell</label>
          <input id="eg-modell" type="text" value="${esc(g.modell ?? '')}"></div>
        <div class="field-group"><label>Aktivierung (YYYY-MM-DD)</label>
          <input id="eg-aktiv" type="date" value="${g.aktivierung ?? ''}"></div>
        <div class="field-group"><label>Laufzeit (Jahre)</label>
          <input id="eg-laufzeit" type="number" value="${g.laufzeit_jahre ?? ''}"></div>
        <div class="field-group"><label>Ablauf (YYYY-MM-DD)</label>
          <input id="eg-ablauf" type="date" value="${g.ablauf ?? ''}"></div>
        <div class="field-group"><label>Prüfmethode</label>
          <input id="eg-pruef" type="text" value="${esc(g.pruefmethode ?? '')}"></div>
        <div class="field-group"><label>Bemerkung</label>
          <input id="eg-bem" type="text" value="${esc(g.bemerkung ?? '')}"></div>
        <button class="btn-primary" onclick="saveGeraet()">Speichern</button>
        <div class="status" id="eg-status"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

function closeEditGeraet() {
  document.getElementById('edit-overlay')?.remove();
  editGeraetId = null;
}

async function saveGeraet() {
  const status = document.getElementById('eg-status');
  const setS   = (msg, ok = true) => { status.textContent = msg; status.className = 'status ' + (ok ? 'ok' : 'err'); };
  const g = _data.geraete.find(x => x.id === editGeraetId);
  if (!g) return;

  g.name          = document.getElementById('eg-name').value.trim();
  g.ort           = document.getElementById('eg-ort').value.trim();
  g.typ           = document.getElementById('eg-typ').value;
  g.modell        = document.getElementById('eg-modell').value.trim() || null;
  g.aktivierung   = document.getElementById('eg-aktiv').value || null;
  g.laufzeit_jahre = parseInt(document.getElementById('eg-laufzeit').value) || null;
  g.ablauf        = document.getElementById('eg-ablauf').value || null;
  g.pruefmethode  = document.getElementById('eg-pruef').value.trim() || null;
  g.bemerkung     = document.getElementById('eg-bem').value.trim() || null;

  // Ablauf aus Aktivierung + Laufzeit berechnen wenn kein Ablauf angegeben
  if (!g.ablauf && g.aktivierung && g.laufzeit_jahre) {
    try {
      const d = new Date(g.aktivierung);
      d.setFullYear(d.getFullYear() + g.laufzeit_jahre);
      g.ablauf = d.toISOString().slice(0, 10);
    } catch (_) {}
  }

  if (!g.name) { setS('⚠️ Name erforderlich', false); return; }
  if (!g.ort)  { setS('⚠️ Ort erforderlich', false); return; }

  setS('⏳ Speichern…');
  try {
    if (editGeraetId === null) {
      g.id = uid();
      _data.geraete.push(g);
    }
    await saveData();
    setS('✅ Gespeichert');
    setTimeout(() => {
      closeEditGeraet();
      closeDetail();
      renderGeraete();
    }, 800);
  } catch (e) {
    setS('❌ ' + e.message.slice(0, 80), false);
  }
}

// ── Init ─────────────────────────────────────────────────────────

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  document.addEventListener('input', e => {
    if (e.target.classList.contains('auto-grow')) {
      e.target.style.height = 'auto';
      e.target.style.height = e.target.scrollHeight + 'px';
    }
  });
  if (location.search.includes('code=')) await handleCallback();
  if (isConnected()) {
    renderApp();
    await loadData();
    renderTab();
  } else {
    renderSetup();
  }
}

init();
