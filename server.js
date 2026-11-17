import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = env.PORT || 3000;

// ---------- Firebase Admin ----------
if (!env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT. See .env.example');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const userDoc = (uid) => db.collection('users').doc(uid);

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://www.gstatic.com'],
        connectSrc: [
          "'self'",
          'https://identitytoolkit.googleapis.com',
          'https://securetoken.googleapis.com',
          'https://www.googleapis.com',
          'https://*.firebaseapp.com',
        ],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameSrc: ["'self'", 'https://*.firebaseapp.com', 'https://accounts.google.com'],
        mediaSrc: ["'self'", 'blob:'],
      },
    },
  })
);
app.use(express.json({ limit: '8mb' })); // images arrive as base64 data URLs
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) =>
  res.json({
    firebase: {
      apiKey: env.FIREBASE_WEB_API_KEY,
      authDomain: env.FIREBASE_AUTH_DOMAIN,
      projectId: env.FIREBASE_PROJECT_ID,
      appId: env.FIREBASE_APP_ID,
    },
    features: {
      search: !!env.TAVILY_API_KEY,
      vision: !!(env.VISION_API_KEY && env.VISION_MODEL),
      tts: !!(env.TTS_API_KEY && env.TTS_MODEL),
    },
  })
);

// ---------- Auth ----------
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please sign in.' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.publicMessage || 'Something went wrong. Please try again.' });
  });
const fail = (status, publicMessage) => Object.assign(new Error(publicMessage), { status, publicMessage });

async function timedFetch(url, opts, ms = 45_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    throw fail(504, e.name === 'AbortError' ? 'The AI service took too long. Please retry.' : 'Could not reach the AI service.');
  } finally {
    clearTimeout(t);
  }
}

// ---------- Prompt ----------
const LANGS = { en: 'English', hi: 'Hindi (Devanagari)', or: 'Odia (ଓଡ଼ିଆ)' };
function systemPrompt({ language, concise, memories, prefs, sources }) {
  let p = `You are LIPSA AI ULTRA (v6.0), a friendly, caring, intelligent female AI assistant. Tagline: "Your Intelligent World."
Personality: warm, polite, patient, creative, emotionally understanding, gently funny, professional when needed. Speak naturally, not robotically. Do not repeat greetings every turn. Respect user boundaries. You are an AI: never claim to be human.
Skills: reasoning, maths, science (physics, chemistry, biology), computer science, English, exam prep, notes, practice questions, and coding (HTML, CSS, JavaScript, Python, Java, React, Node.js) with code in fenced blocks.
Reply in ${LANGS[language] || 'the user\'s language'} unless the user writes in another language. ${concise ? 'Keep answers short and direct.' : 'Give clear, detailed explanations when useful.'}
For planners/reminders/calendar: you cannot act externally; suggest the action and ask the user to confirm in the app.
If you are unsure, say so rather than inventing facts.`;
  if (prefs?.name) p += `\nThe user's name is ${prefs.name}.`;
  if (memories?.length) p += `\nUser-approved saved memories (private):\n${memories.map((m) => '- ' + m).join('\n')}`;
  if (sources?.length)
    p += `\nLive web results are below. Use them for current facts and cite as [1], [2]...:\n${sources
      .map((s, i) => `[${i + 1}] ${s.title} (${s.url}): ${s.content}`)
      .join('\n')}`;
  return p;
}

// ---------- Search ----------
async function webSearch(query) {
  if (!env.TAVILY_API_KEY) throw fail(501, 'Web search is not configured on the server.');
  const r = await timedFetch(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: 5, search_depth: 'basic' }),
    },
    20_000
  );
  if (!r.ok) throw fail(502, 'Web search failed.');
  const j = await r.json();
  return (j.results || []).map((x) => ({ title: x.title, url: x.url, content: (x.content || '').slice(0, 600) }));
}

app.post(
  '/api/search',
  auth,
  wrap(async (req, res) => {
    const q = String(req.body.query || '').trim().slice(0, 300);
    if (!q) throw fail(400, 'Query required.');
    res.json({ sources: await webSearch(q) });
  })
);

// ---------- Chat ----------
async function deepseek(messages) {
  if (!env.DEEPSEEK_API_KEY || !env.DEEPSEEK_MODEL) throw fail(501, 'AI engine is not configured on the server.');
  const r = await timedFetch(`${env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL,
      messages,
      temperature: Number(env.DEEPSEEK_TEMPERATURE || 0.7),
      max_tokens: Number(env.DEEPSEEK_MAX_TOKENS || 2048),
    }),
  });
  if (!r.ok) {
    console.error('DeepSeek error', r.status, await r.text().catch(() => ''));
    throw fail(r.status === 429 ? 429 : 502, r.status === 429 ? 'The AI is busy. Please retry shortly.' : 'The AI service returned an error.');
  }
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || '';
}

async function vision(question, imageDataUrl, history) {
  if (!env.VISION_API_KEY || !env.VISION_MODEL) throw fail(501, 'Image understanding is not configured on the server.');
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(imageDataUrl)) throw fail(400, 'Unsupported image format.');
  const r = await timedFetch(`${env.VISION_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.VISION_API_KEY}` },
    body: JSON.stringify({
      model: env.VISION_MODEL,
      max_tokens: Number(env.DEEPSEEK_MAX_TOKENS || 2048),
      messages: [
        ...history,
        {
          role: 'user',
          content: [
            { type: 'text', text: question || 'Explain this image in detail. If it is a document, diagram or screenshot, summarise and explain it.' },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  }, 60_000);
  if (!r.ok) throw fail(502, 'Image analysis failed.');
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || '';
}

app.post(
  '/api/chat',
  auth,
  wrap(async (req, res) => {
    const uid = req.user.uid;
    const text = String(req.body.message || '').trim().slice(0, 8000);
    const image = req.body.image || null;
    if (!text && !image) throw fail(400, 'Message required.');
    const language = LANGS[req.body.language] ? req.body.language : 'en';

    // conversation
    let convRef;
    if (req.body.conversationId) {
      convRef = userDoc(uid).collection('conversations').doc(String(req.body.conversationId));
      if (!(await convRef.get()).exists) throw fail(404, 'Conversation not found.');
    } else {
      convRef = userDoc(uid).collection('conversations').doc();
      await convRef.set({ title: (text || 'Image chat').slice(0, 60), createdAt: Date.now(), updatedAt: Date.now() });
    }

    // history + memory (all private to this user)
    const [histSnap, memSnap, prefSnap] = await Promise.all([
      convRef.collection('messages').orderBy('ts', 'desc').limit(20).get(),
      userDoc(uid).collection('memories').orderBy('ts', 'desc').limit(30).get(),
      userDoc(uid).collection('settings').doc('prefs').get(),
    ]);
    const history = histSnap.docs.map((d) => d.data()).reverse().map((m) => ({ role: m.role, content: m.content }));
    const memories = memSnap.docs.map((d) => d.data().text);
    const prefs = prefSnap.exists ? prefSnap.data() : {};

    let sources = [];
    if (req.body.useSearch && text && !image) {
      try {
        sources = await webSearch(text);
      } catch (e) {
        console.warn('search skipped:', e.message);
      }
    }
    const sys = { role: 'system', content: systemPrompt({ language, concise: !!req.body.concise, memories, prefs, sources }) };

    let reply;
    if (image) reply = await vision(text, image, [sys, ...history.slice(-6)]);
    else reply = await deepseek([sys, ...history, { role: 'user', content: text }]);
    if (!reply) throw fail(502, 'The AI returned an empty answer. Please retry.');

    const now = Date.now();
    const col = convRef.collection('messages');
    await col.add({ role: 'user', content: text || '[image]', hasImage: !!image, ts: now });
    await col.add({ role: 'assistant', content: reply, sources, ts: now + 1 });
    await convRef.update({ updatedAt: now + 1 });
    res.json({ conversationId: convRef.id, reply, sources });
  })
);

// ---------- Optional server-side TTS ----------
app.post(
  '/api/tts',
  auth,
  wrap(async (req, res) => {
    if (!env.TTS_API_KEY || !env.TTS_MODEL) throw fail(501, 'Server TTS not configured.');
    const input = String(req.body.text || '').slice(0, 3000);
    const r = await timedFetch(`${env.TTS_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TTS_API_KEY}` },
      body: JSON.stringify({ model: env.TTS_MODEL, voice: env.TTS_VOICE, input, speed: Number(req.body.speed) || 1 }),
    });
    if (!r.ok) throw fail(502, 'Voice service failed.');
    res.set('Content-Type', r.headers.get('content-type') || 'audio/mpeg');
    res.send(Buffer.from(await r.arrayBuffer()));
  })
);

// ---------- Conversations ----------
app.get('/api/conversations', auth, wrap(async (req, res) => {
  const s = await userDoc(req.user.uid).collection('conversations').orderBy('updatedAt', 'desc').limit(50).get();
  res.json(s.docs.map((d) => ({ id: d.id, ...d.data() })));
}));
app.get('/api/conversations/:id', auth, wrap(async (req, res) => {
  const s = await userDoc(req.user.uid).collection('conversations').doc(req.params.id).collection('messages').orderBy('ts').limit(200).get();
  res.json(s.docs.map((d) => d.data()));
}));
app.delete('/api/conversations/:id', auth, wrap(async (req, res) => {
  await db.recursiveDelete(userDoc(req.user.uid).collection('conversations').doc(req.params.id));
  res.json({ ok: true });
}));
app.delete('/api/conversations', auth, wrap(async (req, res) => {
  await db.recursiveDelete(userDoc(req.user.uid).collection('conversations'));
  res.json({ ok: true });
}));

// ---------- Memory (explicit, user-controlled) ----------
app.get('/api/memory', auth, wrap(async (req, res) => {
  const s = await userDoc(req.user.uid).collection('memories').orderBy('ts', 'desc').get();
  res.json(s.docs.map((d) => ({ id: d.id, ...d.data() })));
}));
app.post('/api/memory', auth, wrap(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) throw fail(400, 'Text required.');
  const ref = await userDoc(req.user.uid).collection('memories').add({ text, ts: Date.now() });
  res.json({ id: ref.id, text });
}));
app.delete('/api/memory/:id', auth, wrap(async (req, res) => {
  await userDoc(req.user.uid).collection('memories').doc(req.params.id).delete();
  res.json({ ok: true });
}));
app.delete('/api/memory', auth, wrap(async (req, res) => {
  await db.recursiveDelete(userDoc(req.user.uid).collection('memories'));
  res.json({ ok: true });
}));

// ---------- Preferences ----------
app.get('/api/prefs', auth, wrap(async (req, res) => {
  const s = await userDoc(req.user.uid).collection('settings').doc('prefs').get();
  res.json(s.exists ? s.data() : {});
}));
app.put('/api/prefs', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const clean = {
    name: String(b.name || '').slice(0, 60),
    language: LANGS[b.language] ? b.language : 'en',
    theme: ['dark', 'light'].includes(b.theme) ? b.theme : 'dark',
    speed: Math.min(2, Math.max(0.5, Number(b.speed) || 1)),
    reducedMotion: !!b.reducedMotion,
    voiceURI: String(b.voiceURI || '').slice(0, 200),
  };
  await userDoc(req.user.uid).collection('settings').doc('prefs').set(clean, { merge: true });
  res.json(clean);
}));

// ---------- Personal assistant items: notes, tasks, reminders, goals, plans ----------
const TYPES = ['note', 'task', 'reminder', 'goal', 'plan'];
app.get('/api/items/:type', auth, wrap(async (req, res) => {
  if (!TYPES.includes(req.params.type)) throw fail(400, 'Unknown type.');
  const s = await userDoc(req.user.uid).collection('items').where('type', '==', req.params.type).get();
  res.json(s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.ts - a.ts));
}));
app.post('/api/items/:type', auth, wrap(async (req, res) => {
  if (!TYPES.includes(req.params.type)) throw fail(400, 'Unknown type.');
  const title = String(req.body.title || '').trim().slice(0, 300);
  if (!title) throw fail(400, 'Title required.');
  const item = {
    type: req.params.type,
    title,
    due: String(req.body.due || '').slice(0, 40),
    progress: Math.min(100, Math.max(0, Number(req.body.progress) || 0)),
    done: false,
    ts: Date.now(),
  };
  const ref = await userDoc(req.user.uid).collection('items').add(item);
  res.json({ id: ref.id, ...item });
}));
app.patch('/api/items/:id', auth, wrap(async (req, res) => {
  const patch = {};
  if ('done' in req.body) patch.done = !!req.body.done;
  if ('progress' in req.body) patch.progress = Math.min(100, Math.max(0, Number(req.body.progress) || 0));
  if ('title' in req.body) patch.title = String(req.body.title).slice(0, 300);
  await userDoc(req.user.uid).collection('items').doc(req.params.id).update(patch);
  res.json({ ok: true });
}));
app.delete('/api/items/:id', auth, wrap(async (req, res) => {
  await userDoc(req.user.uid).collection('items').doc(req.params.id).delete();
  res.json({ ok: true });
}));

// ---------- Delete everything ----------
app.delete('/api/account-data', auth, wrap(async (req, res) => {
  await db.recursiveDelete(userDoc(req.user.uid));
  if (req.query.deleteAccount === '1') await admin.auth().deleteUser(req.user.uid);
  res.json({ ok: true });
}));

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`LIPSA AI ULTRA running on :${PORT}`));
