require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Twilio
const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioFrom = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const client = require('twilio')(accountSid, authToken);

// Groq (OpenAI-compatible API)
const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Default to a free/fast model; can be overridden via env
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

// Basic app
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Load locales for i18n (server-side only for WhatsApp messages)
const locales = {};
function loadLocales(){
  try {
    locales.en = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales', 'en.json'), 'utf8'));
  } catch {}
  try {
    locales.ar = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales', 'ar.json'), 'utf8'));
  } catch {}
}
loadLocales();

function tmpl(str, vars){
  return String(str||'').replace(/\{\{(.*?)\}\}/g, (_,k)=> (vars && vars[k.trim()]!=null)? String(vars[k.trim()]): '');
}
function t(lang, key, vars){
  const parts = key.split('.');
  let cur = locales[lang] || locales.en || {};
  for (const p of parts) cur = (cur||{})[p];
  const base = cur || '';
  return tmpl(base, vars);
}

// MongoDB (optional but recommended)
const MONGODB_URI = process.env.MONGODB_URI;
let dbReady = false;
if (MONGODB_URI) {
  mongoose
    .connect(MONGODB_URI, { dbName: process.env.MONGODB_DB || 'whatsapp_ats' })
    .then(() => {
      dbReady = true;
      console.log('MongoDB connected');
    })
    .catch((err) => {
      console.error('MongoDB connection failed:', err.message);
    });
} else {
  console.warn('MONGODB_URI not set. Running without persistence.');
}

// Schemas & Models
const JobSchema = new mongoose.Schema(
  {
    jobId: { type: String, unique: true, index: true },
    language: { type: String, enum: ['ar','en'], default: 'en' },
    title: String,
    description: String,
    responsibilities: String,
    requirements: String,
    skills: String,
    benefits: String,
    questions: [String],
    candidateRecipients: [String],
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

const SessionSchema = new mongoose.Schema(
  {
    applicantPhone: { type: String, index: true },
    jobId: { type: String, index: true },
    currentIndex: { type: Number, default: 0 },
    answers: [{ question: String, answer: String }],
    processedMessageSids: [String],
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { timestamps: false }
);

const SubmissionSchema = new mongoose.Schema(
  {
    applicantPhone: { type: String, index: true },
    jobId: { type: String, index: true },
    answers: [{ question: String, answer: String }],
    aiScore: { type: Number, default: 0 },
    aiStrengths: [String],
    aiWeaknesses: [String],
    aiDecision: String,
    aiSummary: String,
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

const Job = mongoose.models.Job || mongoose.model('Job', JobSchema);
const Session = mongoose.models.Session || mongoose.model('Session', SessionSchema);
const Submission = mongoose.models.Submission || mongoose.model('Submission', SubmissionSchema);

// Fallback in-memory job if DB missing
const fallbackJobs = new Map();
(function seedSampleJob() {
  const id = 'JOB-DEMO';
  if (!fallbackJobs.has(id)) {
    fallbackJobs.set(id, {
      jobId: id,
      language: 'en',
      title: 'Junior Backend Engineer',
      description: '',
      responsibilities: '',
      requirements: '',
      skills: '',
      benefits: '',
      questions: [
        'Briefly introduce yourself and your experience.',
        'What programming languages and frameworks are you most comfortable with?',
        'Describe a challenging backend problem you solved and how.',
        'What are your salary expectations and notice period?'
      ],
      candidateRecipients: [],
      createdAt: new Date().toISOString(),
    });
  }
})();

// Helpers
function normalizePhone(waFrom) {
  return String(waFrom || '').replace(/^whatsapp:/i, '');
}

function generateJobId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let x = '';
  for (let i = 0; i < 6; i++) x += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `JOB-${x}`;
}

async function sendWhatsApp(to, body) {
  return client.messages.create({ from: twilioFrom, to, body });
}

function toWhatsApp(number) {
  const n = String(number || '').trim();
  if (!n) return null;
  return n.startsWith('whatsapp:') ? n : `whatsapp:${n.startsWith('+') ? n : '+' + n}`;
}

function buildWelcomeMessage(job) {
  const lang = (job.language||'en');
  return t(lang, 'whatsapp.welcome', { jobTitle: job.title });
}

function buildFinalMessage(job) {
  return t((job.language||'en'), 'whatsapp.final');
}

function isStartMessage(job, message) {
  const m = (message || '').trim().toLowerCase();
  if ((job.language || 'en') === 'ar') {
    return /(ابدأ\s*عزّام|ابدا\s*عزام|ابدا\s*عزّام|ابدأ|ابدا)/.test(m);
  }
  return /(start\s*azzam|start)/.test(m);
}

async function converseOnAnswer({ job, sessionDoc, question, message }) {
  // Conversational AI: accepts updates, clarifies, guides; never refuses changes
  const lang = job.language || 'en';
  const sys = {
    role: 'system',
    content: lang === 'ar'
      ? 'أنت "عزّام" مساعد مقابلات ذكي، تتحدث العربية فقط. تصرّف كمقابل بشري: إذا طلب المرشح توضيحًا فاشرح السؤال ثم أعد طرحه، إذا كانت الإجابة غير واضحة فاطلب توضيحًا بلطف، وإذا كانت غير مرتبطة فقم بتوجيهه. إذا أراد تغيير إجابته فاقبل التغيير طبيعيًا. أعد JSON فقط بالشكل: {"assistant_reply":"...","normalized_answer": null أو نص، "action":"answer"|"clarify"|"ask_again"|"guide"}. لا تُضِف أي نص خارج JSON.'
      : 'You are "Azzam", a smart interview assistant. Speak only English. Act like a human interviewer: if the candidate asks for clarification, explain and then re-ask; if the answer is unclear, politely ask for a clearer answer; if unrelated, guide them. If the candidate wants to change an answer, accept the new answer normally. Return JSON only: {"assistant_reply":"...","normalized_answer": null or text, "action":"answer"|"clarify"|"ask_again"|"guide"}. Do not add any text outside JSON.'
  };
  const user = {
    role: 'user',
    content: JSON.stringify({
      job: { title: job.title, language: job.language },
      question,
      previous_answers: sessionDoc.answers || [],
      candidate_message: message
    })
  };
  try {
    const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: GROQ_MODEL, messages: [sys, user], temperature: 0.3 },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } }
    );
    const raw = resp?.data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { action:'ask_again', assistant_reply:'', normalized_answer:null }; }
    return parsed;
  } catch (e) {
    return { action:'ask_again', assistant_reply: '', normalized_answer: null };
  }
}

// (legacy helpers removed)

async function analyzeCandidate(job, answers) {
  const qa = answers.map(a => ({ question: a.question, answer: a.answer }));
  const sys = {
    role: 'system',
    content: (job.language||'en')==='ar'
      ? 'أنت مُقابِل تقني متمرس. قيّم المرشح بعدالة وفق معايير واضحة، وأعد JSON صارم فقط. استخدم مقياس 0–100 حيث 100 ممتاز. عاير الدرجات إنسانيًا: المرشح المتوسط بين 55–85 غالبًا. طبّق محاور التقييم بالأوزان: الوضوح 25%، الملاءمة 35%، الاكتمال 25%، عمق الخبرة 15%. ثم احسب decision وفق العتبات: accept إذا score ≥ 75، review إذا 60–74، reject إذا < 60. لا تُضِف أي نص خارج JSON.'
      : 'You are a senior technical interviewer. Score fairly with a human-calibrated 0–100 scale (100 = excellent). Typical average candidates should land around 55–85 unless answers are truly poor. Use weighted rubric: clarity 25%, relevance 35%, completeness 25%, experience-depth 15%. Then set decision by thresholds: accept if score ≥ 75; review if 60–74; reject if < 60. Return strict JSON only.'
  };

  const user = {
    role: 'user',
    content: (job.language||'en')==='ar'
      ? `قيّم هذا المرشح بناءً على تفاصيل الوظيفة التالية.\n\nتفاصيل الدور:\nالعنوان: ${job.title}\nالوصف: ${job.description || ''}\nالمسؤوليات: ${job.responsibilities || ''}\nالمتطلبات: ${job.requirements || ''}\nالمهارات: ${job.skills || ''}\nالمزايا: ${job.benefits || ''}\ن\nإجابات المرشح:\n${qa.map((x,i)=>`س${i+1}: ${x.question}\nج${i+1}: ${x.answer}`).join('\n')}\n\nأعد JSON فقط بالشكل:\n{\n  "score": number,\n  "strengths": [],\n  "weaknesses": [],\n  "decision": "accept" | "reject" | "review",\n  "summary": ""\n}`
      : `Evaluate this applicant strictly based on the role below.\n\nROLE DETAILS:\nTitle: ${job.title}\nDescription: ${job.description || ''}\nResponsibilities: ${job.responsibilities || ''}\nRequirements: ${job.requirements || ''}\nSkills: ${job.skills || ''}\nBenefits: ${job.benefits || ''}\n\nAPPLICANT ANSWERS:\n${qa.map((x,i)=>`Q${i+1}: ${x.question}\nA${i+1}: ${x.answer}`).join('\n')}\n\nReturn strict JSON:\n{\n  "score": number,\n  "strengths": [],\n  "weaknesses": [],\n  "decision": "accept" | "reject" | "review",\n  "summary": ""\n}`
  };

  try {
    const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: GROQ_MODEL, messages: [sys, user], temperature: 0.2 },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } }
    );

    const raw = resp?.data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    }
    // Post-process: clamp score and derive decision if missing
    let score = Math.round(Number(parsed.score ?? 0));
    if (!Number.isFinite(score)) score = 0;
    if (score < 0) score = 0; if (score > 100) score = 100;
    let decision = (parsed.decision || '').toString().toLowerCase();
    if (!['accept','review','reject'].includes(decision)) {
      if (score >= 75) decision = 'accept';
      else if (score >= 60) decision = 'review';
      else decision = 'reject';
    }
    return {
      score,
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : (parsed.strengths ? [String(parsed.strengths)] : []),
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : (parsed.weaknesses ? [String(parsed.weaknesses)] : []),
      decision,
      summary: String(parsed.summary || '')
    };
  } catch (err) {
    console.error('Groq error:', err?.response?.data || err.message);
    return { score: 0, strengths: [], weaknesses: [], decision: 'review', summary: 'AI analysis failed; manual review required.' };
  }
}

async function finalizeAndNotify(job, sessionDoc) {
  const analysis = await analyzeCandidate(job, sessionDoc.answers || []);

  // Persist submission
  let submission = null;
  if (dbReady) {
    submission = await Submission.create({
      applicantPhone: sessionDoc.from || sessionDoc.applicantPhone,
      jobId: job.jobId || job.id,
      answers: (sessionDoc.answers || []).map(a => ({ question: a.question, answer: a.answer })),
      aiScore: Number(analysis.score || 0),
      aiStrengths: Array.isArray(analysis.strengths) ? analysis.strengths.map(String) : (analysis.strengths ? [String(analysis.strengths)] : []),
      aiWeaknesses: Array.isArray(analysis.weaknesses) ? analysis.weaknesses.map(String) : (analysis.weaknesses ? [String(analysis.weaknesses)] : []),
      aiDecision: String(analysis.decision || 'review'),
      aiSummary: String(analysis.summary || ''),
    });
  }

  return { analysis, submission };
}

// Webhook: Twilio inbound WhatsApp
app.post('/webhook', async (req, res) => {
  const message = (req.body.Body || '').trim();
  const fromWa = (req.body.From || '').trim(); // e.g., whatsapp:+20123456789
  const messageSid = req.body.MessageSid;

  if (!fromWa) {
    res.status(400).send('Missing From');
    return;
  }
  const from = normalizePhone(fromWa);

  // Resolve job: latest created, or fallback
  let job = null;
  if (dbReady) {
    job = await Job.findOne({}).sort({ createdAt: -1 }).lean();
  }
  if (!job) {
    const [single] = fallbackJobs.values();
    if (!single) {
      await sendWhatsApp(fromWa, 'No active job configured.');
      return res.send('OK');
    }
    job = single;
  }

  // Session
  let sessionDoc = dbReady ? await Session.findOne({ applicantPhone: from, jobId: job.jobId, completedAt: null }) : null;

  // Start phrase recognition (based on job.language)
  const normalizedMsg = message.normalize('NFKC').toLowerCase();
  const isStart = isStartMessage(job, normalizedMsg);

  if (!sessionDoc) {
    if (!isStart) {
      // Hint to start based on language
      await sendWhatsApp(fromWa, t((job.language||'en'),'whatsapp.start_hint'));
      return res.send('OK');
    }
    if (dbReady) {
      sessionDoc = await Session.create({ applicantPhone: from, jobId: job.jobId, currentIndex: 0, answers: [], processedMessageSids: [] });
    }
    // First question
    if ((job.questions||[]).length > 0) {
      await sendWhatsApp(fromWa, t((job.language||'en'),'whatsapp.question_prefix', { current: 1, total: job.questions.length, question: job.questions[0] }));
    } else {
      await sendWhatsApp(fromWa, t((job.language||'en'),'whatsapp.no_questions'));
    }
    return res.send('OK');
  }

  // Idempotency for DB sessions
  if (dbReady && messageSid) {
    if (sessionDoc.processedMessageSids.includes(messageSid)) return res.send('OK');
    sessionDoc.processedMessageSids.push(messageSid);
  }

  // Conversational handling for current question
  const idx = sessionDoc.currentIndex || 0;
  if (idx < (job.questions||[]).length) {
    const q = job.questions[idx];
    const guidance = await converseOnAnswer({ job, sessionDoc, question: q, message });
    const action = guidance?.action || 'ask_again';
    const reply = guidance?.assistant_reply || '';
    if (action === 'answer') {
      const ans = guidance?.normalized_answer ?? message;
      sessionDoc.answers = sessionDoc.answers || [];
      if (sessionDoc.answers.length > idx) {
        sessionDoc.answers[idx] = { question: q, answer: ans };
      } else if (sessionDoc.answers.length === idx) {
        sessionDoc.answers.push({ question: q, answer: ans });
      } else {
        while (sessionDoc.answers.length < idx) sessionDoc.answers.push({ question: '', answer: '' });
        sessionDoc.answers.push({ question: q, answer: ans });
      }
      sessionDoc.currentIndex = idx + 1;
      if (dbReady) await sessionDoc.save();
    } else {
      if (reply) await sendWhatsApp(fromWa, reply);
      await sendWhatsApp(fromWa, t((job.language||'en'),'whatsapp.question_prefix', { current: idx+1, total: job.questions.length, question: q }));
      return res.send('OK');
    }
  }

  // Ask next or finalize
  if (sessionDoc.currentIndex < job.questions.length) {
    const nextIdx = sessionDoc.currentIndex;
    await sendWhatsApp(fromWa, t((job.language||'en'),'whatsapp.question_prefix', { current: nextIdx+1, total: job.questions.length, question: job.questions[nextIdx] }));
    return res.send('OK');
  }

  // Finalize
  if (!sessionDoc.completedAt) {
    sessionDoc.completedAt = new Date();
    if (dbReady) await sessionDoc.save();
    await finalizeAndNotify(job, sessionDoc);
    await sendWhatsApp(fromWa, buildFinalMessage(job));
  }
  return res.send('OK');
});

// HR API: create job
app.post('/api/jobs', async (req, res) => {
  const { title, language, description, responsibilities, requirements, skills, benefits, questions, recipients } = req.body || {};
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }
  const lang = (language === 'ar' || language === 'en') ? language : 'en';
  const doc = {
    jobId: generateJobId(),
    title,
    language: lang,
    description: description || '',
    responsibilities: responsibilities || '',
    requirements: requirements || '',
    skills: skills || '',
    benefits: benefits || '',
    questions: Array.isArray(questions) ? questions.map(String) : [],
    candidateRecipients: Array.isArray(recipients) ? recipients.map(String) : [],
  };
  if (dbReady) {
    const created = await Job.create(doc);
    // Send welcome to all candidate recipients immediately
    const msg = buildWelcomeMessage(created);
    for (const r of created.candidateRecipients || []) {
      const to = toWhatsApp(r);
      if (!to) continue;
      try { await sendWhatsApp(to, msg); } catch (e) { console.warn('Welcome send failed', r, e.message); }
    }
    return res.json({ ok: true, job: created });
  } else {
    fallbackJobs.set(doc.jobId, doc);
    const msg = buildWelcomeMessage(doc);
    for (const r of doc.candidateRecipients || []) {
      const to = toWhatsApp(r);
      if (!to) continue;
      try { await sendWhatsApp(to, msg); } catch (e) { console.warn('Welcome send failed', r, e.message); }
    }
    return res.json({ ok: true, job: doc, warning: 'No DB configured; job stored in-memory only.' });
  }
});

// HR API: list jobs
app.get('/api/jobs', async (req, res) => {
  if (dbReady) {
    const all = await Job.find({}).sort({ createdAt: -1 }).lean();
    return res.json(all);
  }
  res.json([...fallbackJobs.values()]);
});

// HR API: get job
app.get('/api/jobs/:jobId', async (req, res) => {
  const jobId = req.params.jobId;
  if (dbReady) {
    const job = await Job.findOne({ jobId }).lean();
    if (!job) return res.status(404).json({ error: 'Not found' });
    return res.json(job);
  }
  const job = fallbackJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

// HR API: update job (send welcome only to newly added candidate numbers)
app.put('/api/jobs/:jobId', async (req, res) => {
  const jobId = req.params.jobId;
  const { title, description, responsibilities, requirements, skills, benefits, questions, recipients } = req.body || {};
  if (dbReady) {
    const job = await Job.findOne({ jobId });
    if (!job) return res.status(404).json({ error: 'Not found' });
    const oldList = Array.isArray(job.candidateRecipients) ? job.candidateRecipients.map(String) : [];
    const newList = Array.isArray(recipients) ? recipients.map(String) : oldList;
    // Compute newly added recipients
    const oldSet = new Set(oldList.map(s => s.trim()));
    const newOnly = newList.filter(s => !oldSet.has(String(s).trim()));
    // Update fields
    if (title != null) job.title = title;
    if (description != null) job.description = description;
    if (responsibilities != null) job.responsibilities = responsibilities;
    if (requirements != null) job.requirements = requirements;
    if (skills != null) job.skills = skills;
    if (benefits != null) job.benefits = benefits;
    if (Array.isArray(questions)) job.questions = questions.map(String);
    job.candidateRecipients = newList;
    await job.save();
    // Send welcome only to new recipients
    const msg = buildWelcomeMessage(job);
    for (const r of newOnly) {
      const to = toWhatsApp(r);
      if (!to) continue;
      try { await sendWhatsApp(to, msg); } catch (e) { console.warn('Welcome send failed', r, e.message); }
    }
    return res.json({ ok: true, job });
  } else {
    const job = fallbackJobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Not found' });
    const oldList = Array.isArray(job.candidateRecipients) ? job.candidateRecipients.map(String) : [];
    const newList = Array.isArray(recipients) ? recipients.map(String) : oldList;
    const oldSet = new Set(oldList.map(s => s.trim()));
    const newOnly = newList.filter(s => !oldSet.has(String(s).trim()));
    if (title != null) job.title = title;
    if (description != null) job.description = description;
    if (responsibilities != null) job.responsibilities = responsibilities;
    if (requirements != null) job.requirements = requirements;
    if (skills != null) job.skills = skills;
    if (benefits != null) job.benefits = benefits;
    if (Array.isArray(questions)) job.questions = questions.map(String);
    job.candidateRecipients = newList;
    fallbackJobs.set(jobId, job);
    const msg = buildWelcomeMessage(job);
    for (const r of newOnly) {
      const to = toWhatsApp(r);
      if (!to) continue;
      try { await sendWhatsApp(to, msg); } catch (e) { console.warn('Welcome send failed', r, e.message); }
    }
    return res.json({ ok: true, job, warning: 'No DB configured; in-memory update only.' });
  }
});

// HR API: job submissions
app.get('/api/jobs/:jobId/submissions', async (req, res) => {
  const jobId = req.params.jobId;
  if (!dbReady) return res.json([]);
  const subs = await Submission.find({ jobId }).sort({ createdAt: -1 }).lean();
  res.json(subs);
});

// HR API: submission by id
app.get('/api/submissions/:id', async (req, res) => {
  if (!dbReady) return res.status(404).json({ error: 'Not found' });
  const sub = await Submission.findById(req.params.id).lean();
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json(sub);
});

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// Public app config for UI branding
function resolveBrandIcon() {
  if (process.env.BRAND_ICON_URL) return process.env.BRAND_ICON_URL;
  try {
    const imagesDir = path.join(process.cwd(), 'public', 'images');
    const files = fs.readdirSync(imagesDir).filter(f => !f.startsWith('.') && f !== '.gitkeep');
    // Prefer brand-icon.* if present
    const preferred = files.find(f => /^brand-icon\.(png|jpg|jpeg|svg|webp)$/i.test(f));
    if (preferred) return `/images/${preferred}`;
    // Else pick the first recognizable image extension
    const firstImg = files.find(f => /\.(png|jpg|jpeg|svg|webp)$/i.test(f));
    if (firstImg) return `/images/${firstImg}`;
  } catch (e) {
    // ignore
  }
  return '/images/brand-icon.png';
}

app.get('/__app_config.json', (_, res) => {
  res.json({
    brandIcon: resolveBrandIcon(),
    brandName: process.env.BRAND_NAME || 'Azzam Assistant • Admin'
  });
});

// Serve lightweight React Admin (via CDN)
app.use(express.static('public'));
// Serve locales for Admin UI i18n
app.use('/locales', express.static('locales'));
app.get(['/','/admin'], (_, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
