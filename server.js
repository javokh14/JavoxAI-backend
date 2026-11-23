import express from 'express';
import cors from 'cors';
import { createClient } from '@libsql/client';

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // Rasm va fayllar uchun hajm

// Turso bazasiga ulanish (Render Environment Variables orqali yoki to'g'ridan-to'g'ri)
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'libsql://javoxai-javokh14.aws-ap-northeast-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTU0MjMwMzAsImlkIjoiMDFhMjA3ODUtYjEwMS03OWI4LWIyNWQtNmM3ZTc5MmNkNjc2Iiwia2lkIjoiZElaN0NzZExlZXZIZkJwU29vWW9nVGNrd3NMczRXSG1LT0x0aTMzT0tPayIsInJpZCI6IjZlYzhmNjY1LWFmNGUtNDhmNy04OWU3LWU2Y2EzZjE5Y2ZiMiJ9.5m0NojyAB2f78YdKTr4vmQHmuzU-X_VL1hbh8wIu7Tip11atoOgX-g7l99ZN7Z3GyPbEgjYsVgGUDuTooUzUBA'
});

// Jadvallarni avtomatik yaratish
async function initDatabase() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        id INTEGER PRIMARY KEY,
        login TEXT NOT NULL,
        password TEXT NOT NULL
      )
    `);
    await db.execute(`
      INSERT OR IGNORE INTO admin_settings (id, login, password)
      VALUES (1, 'javohirjon', 'maxramov')
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        login TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        prompt_limit INTEGER DEFAULT 0,
        prompt_used INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        can_upload INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'untested',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Turso jadvallari tayyor!');
  } catch (err) {
    console.error('❌ Baza yaratishda xatolik:', err);
  }
}

initDatabase();

const PROVIDERS = {
  gemini: { name: 'Google Gemini', model: 'gemini-2.5-flash' },
  groq: { name: 'Groq Cloud', model: 'llama-3.3-70b-versatile' },
  openrouter: { name: 'OpenRouter Free', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  mistral: { name: 'Mistral AI', model: 'mistral-small-latest' },
  cohere: { name: 'Cohere AI', model: 'command-r-plus' },
  huggingface: { name: 'Hugging Face', model: 'Qwen/Qwen2.5-72B-Instruct' }
};

// Server holati (UptimeRobot uchun)
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Javox AI Backend ishlamoqda!' });
});

// ================= 1. AUTH (SIGNUP & LOGIN) =================
app.post('/api/signup', async (req, res) => {
  try {
    const { firstName, lastName, login, password } = req.body;
    if (!firstName || !lastName || !login || !password) {
      return res.status(400).json({ error: "Barcha maydonlarni to'ldiring!" });
    }
    if (login.length < 7 || password.length < 7) {
      return res.status(400).json({ error: "Login va parol kamida 7 ta belgidan iborat bo'lishi kerak!" });
    }
    if (login.toLowerCase() === password.toLowerCase()) {
      return res.status(400).json({ error: "Login va parol bir xil bo'lishi mumkin emas!" });
    }

    const adminRes = await db.execute('SELECT login FROM admin_settings WHERE id = 1');
    if (adminRes.rows[0]?.login.toLowerCase() === login.toLowerCase()) {
      return res.status(400).json({ error: "Bu login band!" });
    }

    const existing = await db.execute({
      sql: 'SELECT id FROM users WHERE LOWER(login) = LOWER(?)',
      args: [login]
    });
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Bu login band! Boshqa login tanlang." });
    }

    const id = Date.now().toString();
    await db.execute({
      sql: 'INSERT INTO users (id, first_name, last_name, login, password) VALUES (?, ?, ?, ?, ?)',
      args: [id, firstName, lastName, login, password]
    });

    res.json({ success: true, message: "Ro'yxatdan o'tish muvaffaqiyatli!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body;

    // Admin tekshiruvi
    const adminRes = await db.execute('SELECT * FROM admin_settings WHERE id = 1');
    const admin = adminRes.rows[0];
    if (admin && admin.login === login && admin.password === password) {
      return res.json({ role: 'admin' });
    }

    // Oddiy foydalanuvchi tekshiruvi
    const userRes = await db.execute({
      sql: 'SELECT * FROM users WHERE login = ? AND password = ?',
      args: [login, password]
    });
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: "Login yoki parol noto'g'ri!" });
    }

    const u = userRes.rows[0];
    res.json({
      role: 'user',
      user: {
        id: u.id,
        firstName: u.first_name,
        lastName: u.last_name,
        login: u.login,
        limit: u.prompt_limit,
        used: u.prompt_used,
        isActive: u.is_active === 1,
        canUpload: u.can_upload === 1
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Foydalanuvchi holatini jonli tekshirish (Sayt o'chirilgan/yoqilganligi va limit)
app.get('/api/user/:id/status', async (req, res) => {
  try {
    const userRes = await db.execute({
      sql: 'SELECT * FROM users WHERE id = ?',
      args: [req.params.id]
    });
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    }
    const u = userRes.rows[0];
    res.json({
      id: u.id,
      firstName: u.first_name,
      lastName: u.last_name,
      login: u.login,
      limit: u.prompt_limit,
      used: u.prompt_used,
      isActive: u.is_active === 1,
      canUpload: u.can_upload === 1
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= 2. AI CALL & SMART AUTO-ROUTER =================
async function executeProviderCall(provider, apiKey, prompt, imageBase64 = null, imageMime = null) {
  if (provider === 'gemini') {
    const parts = [{ text: prompt || 'Ushbu fayl/rasmni tahlil qilib ber.' }];
    if (imageBase64 && imageMime) {
      parts.push({
        inline_data: { mime_type: imageMime, data: imageBase64 }
      });
    }
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || 'Gemini xatosi');
    return data.candidates[0].content.parts[0].text;
  }

  if (provider === 'groq') {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: PROVIDERS.groq.model, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || 'Groq xatosi');
    return data.choices[0].message.content;
  }

  if (provider === 'openrouter') {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://javox.uz',
        'X-Title': 'Javox AI'
      },
      body: JSON.stringify({ model: PROVIDERS.openrouter.model, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || 'OpenRouter xatosi');
    return data.choices[0].message.content;
  }

  if (provider === 'mistral') {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: PROVIDERS.mistral.model, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || 'Mistral xatosi');
    return data.choices[0].message.content;
  }

  if (provider === 'cohere') {
    const res = await fetch('https://api.cohere.ai/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ message: prompt })
    });
    const data = await res.json();
    if (!res.ok || (data.message && !data.text)) throw new Error(data.message || 'Cohere xatosi');
    return data.text;
  }

  if (provider === 'huggingface') {
    const res = await fetch(`https://api-inference.huggingface.co/models/${PROVIDERS.huggingface.model}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: PROVIDERS.huggingface.model, messages: [{ role: 'user', content: prompt }], max_tokens: 800 })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'HuggingFace xatosi');
    return data.choices[0].message.content;
  }
}

function detectBestProviders(prompt, hasImage) {
  if (hasImage) return ['gemini', 'openrouter'];
  const p = (prompt || '').toLowerCase();
  if (p.includes('kod') || p.includes('code') || p.includes('html') || p.includes('python') || p.includes('js') || p.includes('css')) {
    return ['groq', 'gemini', 'mistral', 'openrouter', 'huggingface', 'cohere'];
  }
  if (p.includes('tarjima') || p.includes('translate') || p.includes('ielts') || p.includes('english')) {
    return ['gemini', 'cohere', 'groq', 'openrouter', 'mistral', 'huggingface'];
  }
  return ['gemini', 'groq', 'openrouter', 'mistral', 'cohere', 'huggingface'];
}

app.post('/api/chat', async (req, res) => {
  try {
    const { userId, prompt, selectedModel, imageBase64, imageMime, fileText } = req.body;

    // 1. Foydalanuvchi holati va limitini tekshirish
    const userRes = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const user = userRes.rows[0];
    if (user.is_active !== 1) {
      return res.status(403).json({ error: "Tizim o'chirildi, keyinroq qaytib keling." });
    }
    if (user.prompt_limit > 0 && user.prompt_used >= user.prompt_limit) {
      return res.status(429).json({ error: "Sizning limitingiz tugadi, keyinroq qaytib keling." });
    }
    if ((imageBase64 || fileText) && user.can_upload !== 1) {
      return res.status(403).json({ error: "Sizga rasm va fayl yuklash ruxsati berilmagan!" });
    }

    const fullPrompt = fileText ? `${prompt}\n\n--- Yuklangan fayl matni ---\n${fileText}` : prompt;

    // 2. Qaysi modellarni sinab ko'rish tartibi
    const providerQueue = selectedModel && selectedModel !== 'auto'
      ? [selectedModel]
      : detectBestProviders(fullPrompt, Boolean(imageBase64));

    const keysRes = await db.execute('SELECT * FROM api_keys');
    const allKeys = keysRes.rows;

    let replyText = null;
    let usedProviderName = '';

    for (const prov of providerQueue) {
      const provKeys = allKeys.filter(k => k.provider === prov);
      for (const kRow of provKeys) {
        try {
          replyText = await executeProviderCall(prov, kRow.api_key, fullPrompt, imageBase64, imageMime);
          await db.execute({ sql: "UPDATE api_keys SET status = 'ok' WHERE id = ?", args: [kRow.id] });
          usedProviderName = PROVIDERS[prov].name;
          break;
        } catch (err) {
          await db.execute({ sql: "UPDATE api_keys SET status = 'dead' WHERE id = ?", args: [kRow.id] });
        }
      }
      if (replyText) break;
    }

    if (!replyText) {
      return res.status(503).json({
        error: "Hozircha barcha API kalitlar band yoki limiti tugagan. Admin paneldan yangi tekin API key qo'shing!"
      });
    }

    // 3. Foydalanuvchi ishlatgan prompt sonini oshirish
    await db.execute({
      sql: 'UPDATE users SET prompt_used = prompt_used + 1 WHERE id = ?',
      args: [userId]
    });

    res.json({
      reply: replyText,
      provider: usedProviderName,
      used: user.prompt_used + 1,
      limit: user.prompt_limit
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= 3. ADMIN PANEL ENDPOINTS =================
app.get('/api/admin/users', async (req, res) => {
  const result = await db.execute('SELECT * FROM users ORDER BY created_at DESC');
  res.json(result.rows);
});

app.put('/api/admin/users/:id', async (req, res) => {
  const { firstName, lastName, login, password, promptLimit, promptUsed, isActive, canUpload } = req.body;
  await db.execute({
    sql: `UPDATE users SET first_name=?, last_name=?, login=?, password=?, prompt_limit=?, prompt_used=?, is_active=?, can_upload=? WHERE id=?`,
    args: [firstName, lastName, login, password, promptLimit, promptUsed, isActive ? 1 : 0, canUpload ? 1 : 0, req.params.id]
  });
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [req.params.id] });
  res.json({ success: true });
});

// API Kalitlar boshqaruvi
app.get('/api/admin/keys', async (req, res) => {
  const result = await db.execute('SELECT * FROM api_keys ORDER BY created_at ASC');
  res.json(result.rows);
});

app.post('/api/admin/keys', async (req, res) => {
  const { provider, apiKey } = req.body;
  const id = Date.now().toString();
  await db.execute({
    sql: "INSERT INTO api_keys (id, provider, api_key, status) VALUES (?, ?, ?, 'untested')",
    args: [id, provider, apiKey]
  });
  res.json({ success: true });
});

app.delete('/api/admin/keys/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM api_keys WHERE id = ?', args: [req.params.id] });
  res.json({ success: true });
});

// API Checker (Barcha kalitlarni real tekshirish)
app.post('/api/admin/check-keys', async (req, res) => {
  const keysRes = await db.execute('SELECT * FROM api_keys');
  const keys = keysRes.rows;

  let working = 0;
  let dead = 0;
  const missingProviders = [];

  for (const prov of Object.keys(PROVIDERS)) {
    const provKeys = keys.filter(k => k.provider === prov);
    if (provKeys.length === 0) {
      missingProviders.push(PROVIDERS[prov].name);
      continue;
    }
    for (const k of provKeys) {
      try {
        await executeProviderCall(prov, k.api_key, 'Hi');
        await db.execute({ sql: "UPDATE api_keys SET status = 'ok' WHERE id = ?", args: [k.id] });
        working++;
      } catch (e) {
        await db.execute({ sql: "UPDATE api_keys SET status = 'dead' WHERE id = ?", args: [k.id] });
        dead++;
      }
    }
  }

  res.json({ working, dead, missingProviders });
});

// Admin Login/Parolni o'zgartirish
app.put('/api/admin/credentials', async (req, res) => {
  const { currentLogin, currentPassword, newLogin, newPassword } = req.body;
  const adminRes = await db.execute('SELECT * FROM admin_settings WHERE id = 1');
  const admin = adminRes.rows[0];

  if (admin.login !== currentLogin || admin.password !== currentPassword) {
    return res.status(401).json({ error: "Joriy login yoki parol noto'g'ri!" });
  }
  if (newLogin.length < 7 || newPassword.length < 7 || newLogin.toLowerCase() === newPassword.toLowerCase()) {
    return res.status(400).json({ error: "Yangi login/parol kamida 7 ta belgi va har xil bo'lishi kerak!" });
  }

  await db.execute({
    sql: 'UPDATE admin_settings SET login = ?, password = ? WHERE id = 1',
    args: [newLogin, newPassword]
  });
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Javox AI Server ${PORT}-portda ishga tushdi`));