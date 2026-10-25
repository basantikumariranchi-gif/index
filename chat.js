error: 'AI unavailable'// BlockHub AI backend for Vercel (serverless function).
// Uses Groq's free tier. Your API key stays on the server (never in index.html).
//
// Setup (one time):
//   1. Get a free key at https://console.groq.com  (no credit card needed)
//   2. Vercel dashboard -> your project -> Settings -> Environment Variables
//        Name: GROQ_API_KEY     Value: (your key)
//   3. Redeploy the project.
//
// Groq retires models often. This file tries the models below, and if they are
// all gone it asks Groq which models are available and uses those instead.
// Optional environment variables to override the lists:
//   GROQ_MODELS         comma-separated text models, tried in order
//   GROQ_VISION_MODELS  comma-separated models that can read images
 
const SYSTEM =
  'You are BlockHub, a helpful general-purpose AI assistant inside Minehub-sites. ' +
  'Answer Minecraft, school, coding, science, maths, writing, gaming, general knowledge and everyday questions. ' +
  'Minecraft is your specialty: give exact recipes, commands and steps, say whether something is Java or Bedrock, and mention the game version when it matters. ' +
  'Be accurate, friendly and concise. Keep answers under about 150 words unless the user asks for more detail. For school questions, explain step by step. ' +
  'Do not claim to have performed actions you cannot perform. ' +
  'You were created and developed by Atulya Raj Patel. If anyone asks who created, made, built, developed, designed or owns you, answer that you were created by Atulya Raj Patel. ' +
  'Never say you were made by any other company or person. ' +
  'Write in plain text. Avoid Markdown symbols such as asterisks and hash signs; use simple sentences and numbered lines instead.';
 
const API = 'https://api.groq.com/openai/v1';
const list = (v, d) => (v || d).split(',').map(s => s.trim()).filter(Boolean);
const TEXT_MODELS = () => list(process.env.GROQ_MODELS, 'openai/gpt-oss-20b,openai/gpt-oss-120b,qwen/qwen3.6-27b');
const VISION_MODELS = () => list(process.env.GROQ_VISION_MODELS, 'qwen/qwen3.6-27b,qwen/qwen3.8-27b');
 
// Simple per-visitor limit (best effort; resets when the function restarts).
const hits = new Map();
const LIMIT = 20, WINDOW_MS = 60 * 1000;
function tooMany(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > LIMIT;
}
 
// Reasoning models need a little steering so they answer fast and do not
// spend the whole token budget "thinking". Each model gets extra settings to try first,
// then a plain request if Groq rejects the extras.
function variantsFor(model) {
  if (/gpt-oss/i.test(model)) return [{ reasoning_effort: 'low' }, {}];
  if (/qwen/i.test(model)) return [{ reasoning_effort: 'none' }, {}];
  return [{}];
}
const clean = t => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
 
async function post(path, key, body, ms) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    let data = null;
    try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  } finally {
    clearTimeout(tid);
  }
}
 
// Try each model in turn. Returns { text, model } or null. Notes problems in `st`.
async function tryModels(models, messages, key, st) {
  for (const model of models) {
    if (st.tried.has(model + '|' + messages.length + '|' + st.pass)) continue;
    st.tried.add(model + '|' + messages.length + '|' + st.pass);
    if (Date.now() - st.start > 14000) return null; // stay inside typical serverless time limits
    for (const extra of variantsFor(model)) {
      try {
        const { status, data } = await post('/chat/completions', key,
          Object.assign({ model, messages, temperature: 0.6, max_completion_tokens: 2048 }, extra), 9000);
        if (status >= 200 && status < 300) {
          const text = clean(data?.choices?.[0]?.message?.content);
          if (text) return { text, model };
          st.notes.push(model + ':empty');
          break;
        }
        if (status === 429) { st.rate = true; st.notes.push(model + ':429'); break; }
        if (status === 401 || status === 403) { st.badKey = true; st.notes.push(model + ':' + status); return null; }
        st.notes.push(model + ':' + status);
        console.warn('Groq model failed:', model, status, data?.error?.message);
        if (status !== 400) break; // 400 may just mean "extra setting not supported": retry plain
      } catch (e) {
        st.notes.push(model + ':error');
        console.warn('Groq request error:', model, e && e.message);
        break;
      }
    }
  }
  return null;
}
 
// Ask Groq which models exist right now (used when the built-in names have been retired).
async function discover(key, wantVision, exclude) {
  try {
    const { status, data } = await post('/models', key, null, 5000);
    if (status !== 200 || !Array.isArray(data?.data)) return [];
    const bad = /whisper|guard|safeguard|tts|orpheus|playai|embed|compound|moderation/i;
    const ids = data.data.filter(m => m && m.active !== false).map(m => String(m.id)).filter(id => !bad.test(id) && !exclude.includes(id));
    const score = id => wantVision
      ? (/qwen|vl|vision|maverick|scout|llama-4/i.test(id) ? 0 : 9)
      : (/gpt-oss|qwen|llama|kimi|gemma|mistral/i.test(id) ? 0 : 9);
    return ids.filter(id => score(id) === 0).slice(0, 3);
  } catch (e) { return []; }
}
 
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
 
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'AI is not set up yet' });
 
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many messages. Please wait a minute.' });
 
  // ---- validate input ----
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 8)
    return res.status(400).json({ error: 'Bad request' });
 
  const msgs = [];
  for (const m of body.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string')
      return res.status(400).json({ error: 'Bad request' });
    msgs.push({ role: m.role, content: m.content.slice(0, 24000) });
  }
  if (msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'Bad request' });
 
  const images = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
  for (const u of images) {
    if (typeof u !== 'string' || !u.startsWith('data:image/') || u.length > 2000000)
      return res.status(400).json({ error: 'Bad image' });
  }
 
  const st = { start: Date.now(), tried: new Set(), notes: [], rate: false, badKey: false, pass: 0 };
  const sys = [{ role: 'system', content: SYSTEM }];
  const textMsgs = sys.concat(msgs);
  let found = null;
 
  // ---- 1) images: use a vision model ----
  if (images.length) {
    const last = msgs[msgs.length - 1];
    const withImgs = sys.concat(msgs.slice(0, -1), [{
      role: 'user',
      content: [{ type: 'text', text: last.content }].concat(images.map(u => ({ type: 'image_url', image_url: { url: u } })))
    }]);
    const vm = VISION_MODELS();
    found = await tryModels(vm, withImgs, key, st);
    if (!found && !st.rate && !st.badKey) {
      st.pass++;
      found = await tryModels(await discover(key, true, vm), withImgs, key, st);
    }
    if (!found && !st.rate && !st.badKey) {
      // No vision model worked: answer the text part and say the picture could not be read.
      const last2 = msgs[msgs.length - 1];
      const noPic = sys.concat(msgs.slice(0, -1), [{ role: 'user',
        content: last2.content + '\n\n[Note: the user attached picture(s), but you cannot view images right now. Say so briefly, then help with the text part of the question.]' }]);
      st.pass++;
      found = await tryModels(TEXT_MODELS(), noPic, key, st);
    }
  } else {
    // ---- 2) normal text chat ----
    const tm = TEXT_MODELS();
    found = await tryModels(tm, textMsgs, key, st);
    if (!found && !st.rate && !st.badKey) {
      st.pass++;
      found = await tryModels(await discover(key, false, tm), textMsgs, key, st);
    }
  }
 
  if (found) return res.status(200).json({ text: found.text, model: found.model });
  if (st.badKey) {
    console.error('Groq rejected the API key');
    return res.status(500).json({ error: 'AI key problem' });
  }
  if (st.rate) return res.status(429).json({ error: 'BlockHub is busy. Please try again in a minute.' });
  console.error('All Groq models failed:', st.notes.join(', '));
  return res.status(502).json({ error: 'AI unavailable', detail: st.notes.slice(0, 6).join(', ') });
};
 
