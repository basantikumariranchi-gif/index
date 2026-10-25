// BlockHub AI backend for Vercel (serverless function).
// Uses Groq's free tier. Your API key stays on the server (never in index.html).
//
// Setup (one time):
//   1. Get a free key at https://console.groq.com  (no credit card needed)
//   2. Vercel dashboard -> your project -> Settings -> Environment Variables
//        Name: GROQ_API_KEY     Value: (your key)
//   3. Redeploy the project.
//
// Optional environment variables (only if Groq renames or retires a model):
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
 
const list = (v, d) => (v || d).split(',').map(s => s.trim()).filter(Boolean);
const TEXT_MODELS = () => list(process.env.GROQ_MODELS, 'llama-3.3-70b-versatile,llama-3.1-8b-instant');
const VISION_MODELS = () => list(process.env.GROQ_VISION_MODELS, 'meta-llama/llama-4-scout-17b-16e-instruct');
 
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
 
async function callGroq(model, messages, key) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages, temperature: 0.6, max_completion_tokens: 1024 }),
      signal: ctrl.signal
    });
    let data = null;
    try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  } finally {
    clearTimeout(tid);
  }
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
 
  const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
  for (const u of images) {
    if (typeof u !== 'string' || !u.startsWith('data:image/') || u.length > 2000000)
      return res.status(400).json({ error: 'Bad image' });
  }
 
  let models = TEXT_MODELS();
  if (images.length) {
    const last = msgs[msgs.length - 1];
    msgs[msgs.length - 1] = {
      role: 'user',
      content: [{ type: 'text', text: last.content }].concat(images.map(u => ({ type: 'image_url', image_url: { url: u } })))
    };
    models = VISION_MODELS();
  }
  const full = [{ role: 'system', content: SYSTEM }].concat(msgs);
 
  // ---- ask Groq, trying the next model if one is busy or retired ----
  let sawRateLimit = false;
  for (const model of models) {
    try {
      const { status, data } = await callGroq(model, full, key);
      if (status >= 200 && status < 300) {
        const text = String(data?.choices?.[0]?.message?.content || '').trim();
        if (text) return res.status(200).json({ text, model });
        continue;
      }
      if (status === 429) { sawRateLimit = true; continue; }
      if (status === 401 || status === 403) {
        console.error('Groq rejected the API key:', status, data?.error?.message);
        return res.status(500).json({ error: 'AI key problem' });
      }
      console.warn('Groq model failed:', model, status, data?.error?.message);
    } catch (e) {
      console.warn('Groq request error:', model, e && e.message);
    }
  }
  if (sawRateLimit) return res.status(429).json({ error: 'BlockHub is busy. Please try again in a minute.' });
  return res.status(502).json({ error: 'AI unavailable' });
};
 
