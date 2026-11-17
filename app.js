import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = {
  fbAuth: null, convId: null, image: null, search: false, busy: false,
  prefs: { language: 'en', theme: 'dark', speed: 1, reducedMotion: false, voiceURI: '', name: '' },
  autoSpeak: true, concise: false, orb: 'idle', lastReply: '', live: false, listening: false, speaking: false, plType: 'task',
};

// ---------- API ----------
async function api(path, opts = {}) {
  const user = state.fbAuth.currentUser;
  if (!user) throw new Error('Please sign in.');
  const token = await user.getIdToken();
  let r;
  try {
    r = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch { throw new Error('You appear to be offline.'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
  return opts.raw ? r : r.json();
}

// ---------- Boot / auth ----------
(async function boot() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  const fbApp = initializeApp(cfg.firebase);
  state.fbAuth = getAuth(fbApp);
  state.features = cfg.features;
  if (!cfg.features.search) $('#searchBtn').hidden = true;
  if (!cfg.features.vision) $('#imgBtn').hidden = true;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  onAuthStateChanged(state.fbAuth, async (u) => {
    $('#welcome').classList.toggle('active', !u);
    $('#app').hidden = !u;
    if (u) { await loadPrefs(); showView('chat'); }
  });
})();

const authMsg = (t, ok) => { $('#authMsg').textContent = t; $('#authMsg').classList.toggle('ok', !!ok); };
const friendly = (e) => ({
  'auth/invalid-credential': 'Wrong email or password.', 'auth/email-already-in-use': 'That email is already registered.',
  'auth/weak-password': 'Password must be at least 6 characters.', 'auth/popup-closed-by-user': 'Sign-in cancelled.',
}[e.code] || 'Sign-in failed. Please try again.');
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault(); authMsg('');
  try { await signInWithEmailAndPassword(state.fbAuth, $('#email').value, $('#password').value); } catch (x) { authMsg(friendly(x)); }
});
$('#signUp').onclick = async () => {
  authMsg('');
  try { await createUserWithEmailAndPassword(state.fbAuth, $('#email').value, $('#password').value); } catch (x) { authMsg(friendly(x)); }
};
$('#googleBtn').onclick = async () => {
  try { await signInWithPopup(state.fbAuth, new GoogleAuthProvider()); } catch (x) { authMsg(friendly(x)); }
};
$('#signOut').onclick = () => { stopSpeak(); signOut(state.fbAuth); };

// ---------- Navigation ----------
function showView(v) {
  $$('.view').forEach((x) => x.classList.toggle('active', x.id === 'v-' + v));
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('#nav').classList.remove('open');
  if (v !== 'voice') { state.live = false; $('#liveBtn').setAttribute('aria-pressed', 'false'); stopListen(); }
  if (v === 'history') loadHistory();
  if (v === 'memory') loadMemory();
  if (v === 'planner') loadItems();
}
$$('#nav button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
$('#menuBtn').onclick = () => $('#nav').classList.toggle('open');
$('#newChat').onclick = () => { state.convId = null; $('#messages').innerHTML = ''; showView('chat'); };
const netUpdate = () => ($('#netBadge').hidden = navigator.onLine);
addEventListener('online', netUpdate); addEventListener('offline', netUpdate); netUpdate();

// ---------- Prefs ----------
async function loadPrefs() {
  try { Object.assign(state.prefs, await api('/api/prefs')); } catch {}
  const ls = JSON.parse(localStorage.getItem('lipsa-local') || '{}');
  state.autoSpeak = ls.autoSpeak ?? true; state.concise = !!ls.concise;
  applyPrefs();
}
function applyPrefs() {
  const p = state.prefs;
  document.documentElement.dataset.theme = p.theme;
  document.body.classList.toggle('reduce', !!p.reducedMotion);
  $('#sName').value = p.name || ''; $('#sLang').value = p.language; $('#sTheme').value = p.theme;
  $('#sSpeed').value = p.speed; $('#sMotion').checked = !!p.reducedMotion;
  $('#sAuto').checked = state.autoSpeak; $('#sConcise').checked = state.concise;
  fillVoices();
}
$('#saveSettings').onclick = async () => {
  Object.assign(state.prefs, {
    name: $('#sName').value, language: $('#sLang').value, theme: $('#sTheme').value,
    speed: Number($('#sSpeed').value), reducedMotion: $('#sMotion').checked, voiceURI: $('#sVoice').value,
  });
  state.autoSpeak = $('#sAuto').checked; state.concise = $('#sConcise').checked;
  localStorage.setItem('lipsa-local', JSON.stringify({ autoSpeak: state.autoSpeak, concise: state.concise }));
  try { await api('/api/prefs', { method: 'PUT', body: state.prefs }); toast('Saved'); } catch (e) { toast(e.message); }
  applyPrefs();
};
$('#micPerm').onclick = async () => {
  try {
    const s = await navigator.permissions?.query({ name: 'microphone' });
    $('#micState').textContent = `Microphone permission: ${s ? s.state : 'unknown'}. Change it in your browser/site settings.`;
  } catch { $('#micState').textContent = 'Check your browser or phone settings for microphone access.'; }
};
function toast(t) { $('#chatErr').textContent = ''; $('#micState').textContent = t; setTimeout(() => ($('#micState').textContent = ''), 2500); }

// ---------- Chat ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function render(text) {
  // safe minimal markdown: code fences, inline code, bold
  const parts = text.split(/```/);
  return parts.map((p, i) => {
    if (i % 2) return `<pre><code>${esc(p.replace(/^\w*\n/, ''))}</code></pre>`;
    return esc(p).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  }).join('');
}
function addBubble(role, text, { sources = [], image } = {}) {
  const d = document.createElement('div');
  d.className = 'bubble ' + (role === 'user' ? 'user' : 'ai');
  d.innerHTML = (image ? `<img src="${image}" alt="Uploaded">` : '') + render(text);
  if (sources.length) {
    sources.forEach((s, i) => {
      const a = document.createElement('a');
      a.className = 'src'; a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = `[${i + 1}] ${s.title || s.url}`; d.appendChild(a);
    });
  }
  if (role !== 'user') {
    const acts = document.createElement('div'); acts.className = 'acts';
    const sp = document.createElement('button'); sp.textContent = '🔊 Speak'; sp.onclick = () => speak(text);
    const cp = document.createElement('button'); cp.textContent = 'Copy'; cp.onclick = () => navigator.clipboard?.writeText(text);
    acts.append(sp, cp); d.appendChild(acts);
  }
  $('#messages').appendChild(d); d.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

async function ask(text, { fromVoice = false } = {}) {
  if (state.busy || (!text && !state.image)) return;
  state.busy = true; $('#chatErr').textContent = ''; $('#sendBtn').disabled = true;
  const image = state.image;
  addBubble('user', text || '(image)', { image });
  clearImage(); $('#typing').hidden = false; setOrb('thinking');
  try {
    const r = await api('/api/chat', { method: 'POST', body: {
      message: text, image, conversationId: state.convId, language: state.prefs.language,
      useSearch: state.search, concise: state.concise,
    } });
    state.convId = r.conversationId; state.lastReply = r.reply;
    addBubble('ai', r.reply, { sources: r.sources });
    if (state.autoSpeak || fromVoice) await speak(r.reply); else setOrb('idle');
  } catch (e) {
    setOrb('error'); $('#chatErr').textContent = e.message; $('#voiceText').textContent = e.message;
    setTimeout(() => setOrb('idle'), 1800);
  } finally {
    $('#typing').hidden = true; state.busy = false; $('#sendBtn').disabled = false;
    if (state.live && !state.speaking) startListen();
  }
}
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault(); const t = $('#input').value.trim(); $('#input').value = ''; autoGrow(); ask(t);
});
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); } });
const autoGrow = () => { const i = $('#input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 120) + 'px'; };
$('#input').addEventListener('input', autoGrow);
$$('#chips button').forEach((b) => (b.onclick = () => { $('#input').value = b.dataset.p; $('#input').focus(); }));
$('#searchBtn').onclick = () => { state.search = !state.search; $('#searchBtn').setAttribute('aria-pressed', state.search); };

// image upload (resized client-side to keep payload small)
$('#imgBtn').onclick = () => $('#imgInput').click();
$('#imgInput').onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image(), url = URL.createObjectURL(f);
  img.onload = () => {
    const s = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    state.image = c.toDataURL('image/jpeg', 0.85); URL.revokeObjectURL(url);
    $('#imgPreview img').src = state.image; $('#imgPreview').hidden = false;
  };
  img.src = url; e.target.value = '';
};
const clearImage = () => { state.image = null; $('#imgPreview').hidden = true; };
$('#rmImg').onclick = clearImage;

// ---------- Voice: TTS ----------
const LANG_TAG = { en: 'en-IN', hi: 'hi-IN', or: 'or-IN' };
let voices = [];
function fillVoices() {
  voices = speechSynthesis?.getVoices?.() || [];
  const sel = $('#sVoice'); sel.innerHTML = '<option value="">Auto (female, matches language)</option>';
  voices.forEach((v) => { const o = document.createElement('option'); o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`; sel.appendChild(o); });
  sel.value = state.prefs.voiceURI || '';
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = fillVoices;
function pickVoice(lang) {
  const chosen = voices.find((v) => v.voiceURI === state.prefs.voiceURI); if (chosen) return chosen;
  const code = lang.slice(0, 2), female = /female|woman|zira|samantha|heera|veena|neerja|swara|google/i;
  const cand = voices.filter((v) => v.lang.toLowerCase().startsWith(code));
  return cand.find((v) => female.test(v.name)) || cand[0] || voices.find((v) => female.test(v.name)) || null;
}
let audioEl = null;
function stopSpeak() {
  speechSynthesis?.cancel(); if (audioEl) { audioEl.pause(); audioEl = null; }
  state.speaking = false; if (state.orb === 'speaking') setOrb('idle');
}
const plain = (t) => t.replace(/```[\s\S]*?```/g, ' (code shown on screen) ').replace(/[*`#_>]/g, '');
async function speak(text) {
  stopSpeak(); stopListen(); state.speaking = true; setOrb('speaking'); setStatus('Speaking');
  const clean = plain(text).slice(0, 3000);
  try {
    if (state.features?.tts) { // premium server TTS, falls back to browser on any failure
      const r = await api('/api/tts', { method: 'POST', body: { text: clean, speed: state.prefs.speed }, raw: true });
      const url = URL.createObjectURL(await r.blob()); audioEl = new Audio(url); audioEl.playbackRate = 1;
      await new Promise((res, rej) => { audioEl.onended = res; audioEl.onerror = rej; audioEl.play().catch(rej); });
    } else await browserSpeak(clean);
  } catch { if (state.speaking) await browserSpeak(clean); }
  const wasSpeaking = state.speaking; state.speaking = false; setOrb('idle'); setStatus('Idle');
  if (wasSpeaking && state.live) startListen();
}
function browserSpeak(text) {
  return new Promise((res) => {
    if (!('speechSynthesis' in window)) return res();
    const u = new SpeechSynthesisUtterance(text), lang = LANG_TAG[state.prefs.language] || 'en-IN';
    u.lang = lang; u.rate = state.prefs.speed; u.pitch = 1.1;
    const v = pickVoice(lang); if (v) u.voice = v;
    u.onend = u.onerror = () => res(); speechSynthesis.speak(u);
  });
}
$('#stopBtn').onclick = () => { stopSpeak(); };
$('#repeatBtn').onclick = () => state.lastReply && speak(state.lastReply);

// ---------- Voice: STT ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, voiceFinal = '';
function setStatus(t) { $('#voiceStatus').textContent = t; }
function startListen(fromChat = false) {
  if (!SR) { $('#voiceText').textContent = 'Speech recognition is not supported in this browser. Try Chrome on Android.'; return; }
  if (state.listening || state.busy) return;
  stopSpeak();
  rec = new SR(); rec.lang = LANG_TAG[state.prefs.language] || 'en-IN'; rec.interimResults = true; rec.continuous = false;
  voiceFinal = '';
  rec.onstart = () => { state.listening = true; setOrb('listening'); setStatus('Listening'); $('#micBtn').classList.add('rec'); };
  rec.onresult = (e) => {
    let interim = '';
    for (const r of e.results) r.isFinal ? (voiceFinal += r[0].transcript) : (interim += r[0].transcript);
    $('#voiceText').textContent = voiceFinal + interim;
    if (fromChat) $('#input').value = voiceFinal + interim;
  };
  rec.onerror = (e) => {
    state.listening = false;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { state.live = false; $('#liveBtn').setAttribute('aria-pressed', 'false'); $('#voiceText').textContent = 'Microphone permission denied. Enable it in site settings.'; setOrb('error'); }
    else if (e.error === 'language-not-supported') $('#voiceText').textContent = 'This language is not supported for voice input on your device.';
  };
  rec.onend = () => {
    state.listening = false; $('#micBtn').classList.remove('rec');
    const t = voiceFinal.trim();
    if (t && !fromChat) { setStatus('Thinking'); ask(t, { fromVoice: true }); }
    else if (t && fromChat) { $('#chatForm').requestSubmit(); }
    else { if (state.orb === 'listening') setOrb('idle'); setStatus('Idle'); if (state.live && !state.busy && !state.speaking) setTimeout(() => startListen(), 400); }
  };
  try { rec.start(); } catch {}
}
function stopListen() { try { rec?.abort(); } catch {} state.listening = false; $('#micBtn')?.classList.remove('rec'); }
$('#micBtn').onclick = () => (state.listening ? stopListen() : startListen(true));
$('#talkBtn').onclick = () => (state.listening ? rec.stop() : startListen());
$('#liveBtn').onclick = () => {
  state.live = !state.live; $('#liveBtn').setAttribute('aria-pressed', state.live);
  if (state.live) startListen(); else { stopListen(); stopSpeak(); }
};
$('#orbVoice').onclick = () => { if (state.speaking) { stopSpeak(); startListen(); } else if (!state.listening) startListen(); }; // interrupt / start

// ---------- History / Memory / Planner ----------
const li = (html, ...btns) => { const l = document.createElement('li'); l.innerHTML = html; btns.forEach((b) => l.appendChild(b)); return l; };
const btn = (t, fn, label) => { const b = document.createElement('button'); b.textContent = t; b.setAttribute('aria-label', label || t); b.onclick = fn; return b; };
async function loadHistory() {
  const ul = $('#histList'); ul.innerHTML = '';
  try {
    const items = await api('/api/conversations');
    if (!items.length) ul.innerHTML = '<li>No conversations yet.</li>';
    items.forEach((c) => {
      const l = li(`<span>${esc(c.title)}<small>${new Date(c.updatedAt).toLocaleString()}</small></span>`,
        btn('🗑️', async () => { await api('/api/conversations/' + c.id, { method: 'DELETE' }); if (state.convId === c.id) state.convId = null; loadHistory(); }, 'Delete'));
      l.querySelector('span').style.cursor = 'pointer';
      l.querySelector('span').onclick = () => openConv(c.id);
      ul.appendChild(l);
    });
  } catch (e) { ul.innerHTML = `<li>${esc(e.message)}</li>`; }
}
async function openConv(id) {
  const msgs = await api('/api/conversations/' + id);
  state.convId = id; $('#messages').innerHTML = '';
  msgs.forEach((m) => addBubble(m.role, m.content, { sources: m.sources || [] })); showView('chat');
}
$('#clearHist').onclick = async () => { if (confirm('Delete ALL conversations?')) { await api('/api/conversations', { method: 'DELETE' }); state.convId = null; $('#messages').innerHTML = ''; loadHistory(); } };

async function loadMemory() {
  const ul = $('#memList'); ul.innerHTML = '';
  try {
    const m = await api('/api/memory');
    if (!m.length) ul.innerHTML = '<li>Nothing saved yet.</li>';
    m.forEach((x) => ul.appendChild(li(`<span>${esc(x.text)}</span>`, btn('🗑️', async () => { await api('/api/memory/' + x.id, { method: 'DELETE' }); loadMemory(); }, 'Delete memory'))));
  } catch (e) { ul.innerHTML = `<li>${esc(e.message)}</li>`; }
}
$('#memForm').onsubmit = async (e) => { e.preventDefault(); await api('/api/memory', { method: 'POST', body: { text: $('#memText').value } }); $('#memText').value = ''; loadMemory(); };
$('#clearMem').onclick = async () => { if (confirm('Delete all memories?')) { await api('/api/memory', { method: 'DELETE' }); loadMemory(); } };

$$('#plTabs button').forEach((b) => (b.onclick = () => { state.plType = b.dataset.t; $$('#plTabs button').forEach((x) => x.classList.toggle('active', x === b)); loadItems(); }));
async function loadItems() {
  const ul = $('#plList'); ul.innerHTML = '';
  try {
    const items = await api('/api/items/' + state.plType);
    if (!items.length) ul.innerHTML = '<li>Nothing here yet.</li>';
    items.forEach((it) => {
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = it.done; cb.style.width = 'auto';
      cb.onchange = async () => { await api('/api/items/' + it.id, { method: 'PATCH', body: { done: cb.checked } }); loadItems(); };
      const l = li(`<span>${esc(it.title)}${it.due ? `<small>${esc(new Date(it.due).toLocaleString())}</small>` : ''}</span>`, btn('🗑️', async () => { await api('/api/items/' + it.id, { method: 'DELETE' }); loadItems(); }, 'Delete'));
      l.prepend(cb); l.classList.toggle('done', it.done); ul.appendChild(l);
      if (it.type === 'reminder' && it.due && !it.done) scheduleReminder(it);
    });
  } catch (e) { ul.innerHTML = `<li>${esc(e.message)}</li>`; }
}
$('#plForm').onsubmit = async (e) => {
  e.preventDefault();
  if (state.plType === 'reminder' && 'Notification' in window && Notification.permission === 'default') {
    if (confirm('Allow LIPSA to show reminder notifications while this app is open?')) await Notification.requestPermission();
  }
  await api('/api/items/' + state.plType, { method: 'POST', body: { title: $('#plTitle').value, due: $('#plDue').value } });
  $('#plTitle').value = ''; $('#plDue').value = ''; loadItems();
};
const timers = new Map();
function scheduleReminder(it) {
  const ms = new Date(it.due) - Date.now(); if (timers.has(it.id) || ms < 0 || ms > 2 ** 31 - 1) return;
  timers.set(it.id, setTimeout(() => { if (Notification.permission === 'granted') new Notification('LIPSA reminder', { body: it.title }); else alert('Reminder: ' + it.title); }, ms));
}

$('#delData').onclick = async () => { if (confirm('Permanently delete all your conversations, memories, notes and settings?')) { await api('/api/account-data', { method: 'DELETE' }); state.convId = null; $('#messages').innerHTML = ''; toast('All data deleted'); } };
$('#delAcct').onclick = async () => { if (confirm('Delete your account and all data? This cannot be undone.')) { await api('/api/account-data?deleteAccount=1', { method: 'DELETE' }); signOut(state.fbAuth); } };

// ---------- Orb + galaxy ----------
function setOrb(s) { state.orb = s; if (s === 'error') setStatus('Error'); else if (s === 'thinking') setStatus('Thinking'); }
const orbs = [$('#orbWelcome'), $('#orbVoice')].map((c) => ({ c, x: c.getContext('2d') }));
const particles = Array.from({ length: 40 }, () => ({ a: Math.random() * 6.28, r: 0.3 + Math.random() * 0.6, s: 0.2 + Math.random() }));
function drawOrb({ c, x }, t) {
  if (!c.offsetParent) return;
  const W = c.width, cx = W / 2, R = W * 0.26, s = state.orb, motion = !state.prefs.reducedMotion;
  x.clearRect(0, 0, W, W);
  const float = s === 'idle' && motion ? Math.sin(t / 900) * 5 : 0, cy = cx + float;
  const err = s === 'error', hue = err ? ['#fca5a5', '#ef4444'] : ['#22d3ee', '#8b5cf6'];
  const pulse = 1 + (motion ? Math.sin(t / (s === 'idle' ? 1400 : 400)) * 0.04 : 0);
  const g = x.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R * pulse);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, hue[0]); g.addColorStop(1, hue[1]);
  x.shadowColor = hue[0]; x.shadowBlur = 40; x.fillStyle = g;
  x.beginPath(); x.arc(cx, cy, R * pulse, 0, 6.28); x.fill(); x.shadowBlur = 0;
  if (!motion) return;
  if (s === 'listening') for (let i = 0; i < 3; i++) { const p = ((t / 1200 + i / 3) % 1); x.strokeStyle = `rgba(34,211,238,${1 - p})`; x.lineWidth = 2; x.beginPath(); x.arc(cx, cy, R + p * R * 0.9, 0, 6.28); x.stroke(); }
  if (s === 'thinking') for (let i = 0; i < 3; i++) { x.save(); x.translate(cx, cy); x.rotate(t / (700 + i * 300) * (i % 2 ? -1 : 1)); x.scale(1, 0.35 + i * 0.2); x.strokeStyle = ['#22d3ee', '#8b5cf6', '#3b82f6'][i]; x.lineWidth = 2.5; x.beginPath(); x.arc(0, 0, R * (1.25 + i * 0.12), 0, 6.28); x.stroke(); x.restore(); }
  if (s === 'speaking') { const n = 36; for (let i = 0; i < n; i++) { const a = i / n * 6.28, h = R * 0.15 + Math.abs(Math.sin(t / 130 + i * 1.7)) * R * 0.45; x.strokeStyle = '#22d3ee'; x.lineWidth = 3; x.beginPath(); x.moveTo(cx + Math.cos(a) * (R + 8), cy + Math.sin(a) * (R + 8)); x.lineTo(cx + Math.cos(a) * (R + 8 + h), cy + Math.sin(a) * (R + 8 + h)); x.stroke(); } }
  if (s === 'thinking' || s === 'processing') particles.forEach((p) => { const a = p.a + t / 1000 * p.s, r = R * (1.2 + p.r); x.fillStyle = 'rgba(139,92,246,.8)'; x.beginPath(); x.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2, 0, 6.28); x.fill(); });
  if (err) { x.strokeStyle = `rgba(239,68,68,${0.4 + Math.sin(t / 150) * 0.3})`; x.lineWidth = 3; x.beginPath(); x.arc(cx, cy, R * 1.2, 0, 6.28); x.stroke(); }
}
const gal = $('#galaxy'), gx = gal.getContext('2d'); let stars = [];
function sizeGal() { gal.width = innerWidth; gal.height = innerHeight; const n = Math.min(110, Math.floor(innerWidth * innerHeight / 14000)); stars = Array.from({ length: n }, () => ({ x: Math.random() * gal.width, y: Math.random() * gal.height, r: Math.random() * 1.6 + 0.3, v: Math.random() * 0.15 + 0.02, h: Math.random() > 0.5 ? '34,211,238' : '167,139,250' })); }
addEventListener('resize', sizeGal); sizeGal();
function frame(t) {
  gx.clearRect(0, 0, gal.width, gal.height);
  const motion = !state.prefs.reducedMotion;
  stars.forEach((s) => { if (motion) { s.y -= s.v; if (s.y < 0) s.y = gal.height; } gx.fillStyle = `rgba(${s.h},${0.35 + Math.sin(t / 700 + s.x) * 0.25 * (motion ? 1 : 0)})`; gx.beginPath(); gx.arc(s.x, s.y, s.r, 0, 6.28); gx.fill(); });
  orbs.forEach((o) => drawOrb(o, t));
  if (!document.hidden) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
document.addEventListener('visibilitychange', () => !document.hidden && requestAnimationFrame(frame));
