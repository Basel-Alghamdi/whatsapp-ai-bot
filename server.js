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

// OpenAI (primary) and Groq (fallback)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Default to a Chat Completions-compatible model
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

// Heuristic controls
const MAX_FOLLOW_UPS = Number(process.env.MAX_FOLLOW_UPS || 2);

// Basic app
const app = express();
// Public health endpoint (must be available before any middleware)
app.get('/health', (req, res) => res.status(200).send('OK'));
// Safe to attach middleware after health
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Startup log for LLM provider
if (OPENAI_API_KEY) {
  console.log(`[Startup] Using OpenAI model: ${OPENAI_MODEL}`);
} else {
  console.warn('[Startup] OPENAI_API_KEY not set. LLM calls will not proceed.');
}

// Global crash diagnostics and graceful shutdown
process.on('unhandledRejection', (reason, p) => {
  try {
    console.error('[UnhandledRejection]', reason);
  } catch {}
});
process.on('uncaughtException', (err) => {
  try {
    console.error('[UncaughtException]', err && (err.stack || err.message || err));
  } catch {}
});
process.on('SIGTERM', () => {
  console.warn('[Shutdown] SIGTERM received');
  if (global.__server && typeof global.__server.close === 'function') {
    try { global.__server.close(() => console.log('[Shutdown] HTTP server closed')); } catch {}
  }
});
process.on('SIGINT', () => {
  console.warn('[Shutdown] SIGINT received');
  if (global.__server && typeof global.__server.close === 'function') {
    try { global.__server.close(() => console.log('[Shutdown] HTTP server closed')); } catch {}
  }
});

// Optional memory log for debugging (enable with LOG_MEM=1)
if (process.env.LOG_MEM === '1') {
  setInterval(() => {
    const m = process.memoryUsage();
    console.log(`[Mem] rss=${(m.rss/1048576).toFixed(1)}MB heapUsed=${(m.heapUsed/1048576).toFixed(1)}MB`);
  }, 60000).unref();
}

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
    sentRecipients: { type: [String], default: [] },
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
    interviewStarted: { type: Boolean, default: false },
    expectingClarification: { type: Boolean, default: false },
    lastUserAnswer: { type: String, default: '' },
    pendingQuestion: { type: String, default: '' },
    // New: track follow-ups per question and which need manual review
    followUpCounts: { type: [Number], default: [] },
    needsReview: { type: [Number], default: [] },
    conversationHistory: [{ role: String, content: String }],
  },
  { timestamps: false }
);

const SubmissionSchema = new mongoose.Schema(
  {
    applicantPhone: { type: String, index: true },
    // Optional: for web-channel identification (dev only)
    applicantEmail: { type: String, index: true },
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
  try {
    if (!to || !body) return null;
    return await client.messages.create({ from: twilioFrom, to, body });
  } catch (err) {
    console.error('Twilio error:', err?.message || err);
    return null;
  }
}

function toWhatsApp(number) {
  const n = String(number || '').trim();
  if (!n) return null;
  return n.startsWith('whatsapp:') ? n : `whatsapp:${n.startsWith('+') ? n : '+' + n}`;
}

function buildWelcomeMessage(job) {
  const lang = (job.language||'en');
  if (lang === 'ar') {
    return `مرحبًا 👋\nأنا عزّام، المساعد الذكي للتوظيف في الشركة.\nاطلعت على طلبك وبسألك كم سؤال للتعرّف عليك أكثر.\nإذا كنت جاهز، خبرني بأي كلمة مثل: جاهز، خلّنا نبدأ، تمام.`;
  }
  return `Hi 👋\nI’m Azzam, the intelligent hiring assistant for the company.\nI reviewed your application and will ask a few quick questions to get to know you better.\nIf you’re ready, let me know with any phrase like: ready, let’s start, okay.`;
}

function buildFinalMessage(job) {
  return t((job.language||'en'), 'whatsapp.final');
}

function isStartMessage(job, message) {
  // Normalize to handle Arabic punctuation and curly apostrophes
  const m = String(message || '').normalize('NFKC').trim().toLowerCase();
  // Arabic variants (include feminine/plural + common typos)
  const arReady = /(جاهز|جاهزه|جاهزة|جاهزين|حاهز|يلا|يلا\s*نبدأ|يلا\s*نکمل|يلا\s*نكمل|تمام|اوكي|أوكي|اوكيه|اوكي\s*نبدأ|تمام\s*نبدأ|خلنا\s*نبدأ|خلّنا\s*نبدأ|لنبدأ|نبدأ|نبدأ؟|ابدا|ابدأ|بدا|بدأ|انطلق|خلاص\s*نبدأ|تمام\s*نكمل|نكمّل|نكمل)/;
  // English readiness and casual phrases (always accepted regardless of job language)
  const enReady = /(ready|let\s*'?s\s*start|lets\s*start|okay\s*let'?s\s*begin|ok\s*begin|ok\s*start|begin|start\b|go\s*ahead|let'?s\s*go|sounds\s*good|we\s*can\s*start|proceed|continue)/;
  // Always test both Arabic and English readiness regardless of job.language
  return arReady.test(m) || enReady.test(m);
}

function isClarification(message) {
  const m = String(message || '').normalize('NFKC').trim().toLowerCase();
  return /(ما\s*فهمت|وضح|توضيح|اشرح|شرح|explain|what\s+do\s+you\s+mean|i\s+don'?t\s+understand|not\s+understand)/.test(m);
}

function isUserQuestion(message) {
  const m = String(message || '').normalize('NFKC').trim();
  if (m.endsWith('?')) return true;
  const lower = m.toLowerCase();
  return /\b(what|why|how|when|where|which|who)\b/.test(lower) || /(كيف|لماذا|متى|أين|اين|كم)/.test(lower);
}

function isProbablyAnswer(message) {
  const m = String(message || '').normalize('NFKC').trim();
  if (!m) return false;
  if (isClarification(m) || isUserQuestion(m) || isStartMessage({language:'en'}, m) || isMetaNonAnswer(m)) return false;
  return true;
}

// Short confirmations that shouldn't be treated as full answers
function isConfirmationOnly(message) {
  const m = String(message || '').normalize('NFKC').trim().toLowerCase();
  if (!m) return false;
  // One- or two-word confirmations common in Arabic/English
  const patterns = [
    /^تم+$/,
    /^تمام$/,
    /^او?كي$/,
    /^أوكي$/,
    /^اوكي\s*نبدأ$/,
    /^تمام\s*نبدأ$/,
    /^يلا$/,
    /^يلا\s*نبدأ$/,
    /^جاهز$/,
    /^جاهزه$/,
    /^جاهزة$/,
    /^حاضر$/,
    /^تمام\s*تمام$/,
    /^go\s*ahead$/,
    /^ok(ay)?$/,
    /^(sounds|looks)\s*good$/,
    /^let'?s\s*go$/,
    /^نبدأ؟$/,
    /^نكمل$/,
    /^تمام\s*نكمل$/,
    /^يلا\s*نكمل$/,
    /^continue$/,
    /^proceed$/
  ];
  return patterns.some((re) => re.test(m));
}

// Meta or administrative messages that are not actual answers
function isMetaNonAnswer(message) {
  const m = String(message || '').normalize('NFKC').trim().toLowerCase();
  if (!m) return false;
  const patterns = [
    // Arabic meta
    /(أتوقع|اتوقع|أعتقد|اعتقد)\s+.*(جاوبت|أجبت)\s+(كل|كافة)\s+(الأسئلة|الاسئلة|اسئلة)/,
    /(جاوبت|أجبت)\s+(كل|كافة)\s+(الأسئلة|الاسئلة|اسئلة)/,
    /(هل\s*(هناك|في)\s*سؤال\s*(آخر|اخر)\??)/,
    /(خلصنا|خلاص|انتهينا|انتهيت|ما\s*عندي\s*(شي|شيء|إضافة|اضافة))/,
    /(هذا\s*كل\s*شي(ء)?)/,
    /(أظن|اظن)\s+كفاية/,
    // English meta
    /i\s*think\s*i('?ve|\s*have)?\s*answered\s*(everything|all)/,
    /(did\s*i|did\s*we)\s*answer\s*(everything|all)/,
    /(anything\s*else\??|any\s*other\s*question\??|any\s*other\s*questions\??)/,
    /(that'?s\s*(all|it))/, 
    /(we\s*are\s*done|i('?m|\s*am)\s*done)/,
    /(no\s*further\s*questions)/
  ];
  return patterns.some((re) => re.test(m));
}

// Heuristic for whether the message has substantive content to count as an answer
function isSubstantiveAnswer(message) {
  const m = String(message || '').normalize('NFKC').trim();
  if (!m) return false;
  if (isConfirmationOnly(m)) return false;
  if (isClarification(m) || isUserQuestion(m)) return false;
  if (isMetaNonAnswer(m)) return false;
  // Softer heuristic: accept if moderate length OR multi-word OR rich punctuation/digits
  if (m.length >= 6) return true;
  if (/\s/.test(m)) return true;
  // Or contains punctuation suggesting explanation or list
  if (/[،,.؛\-•]/.test(m)) return true;
  // Or contains digits (years, levels, versions)
  if (/\d/.test(m)) return true;
  return false;
}

function isValidAnswerContent(message) {
  const m = String(message || '').normalize('NFKC').trim();
  if (!m) return false;
  if (isConfirmationOnly(m)) return false;
  if (isClarification(m) || isUserQuestion(m)) return false;
  if (isMetaNonAnswer(m)) return false;
  return isSubstantiveAnswer(m);
}

// Guardrails: prevent coaching/content-writing phrasing
function sanitizeAssistantReply(text, lang) {
  let out = String(text || '');
  const badPhrases = [
    /i\s+can\s+write\s+a\s+better\s+answer/gi,
    /let\s+me\s+craft\s+the\s+answer/gi,
    /i\s+can\s+craft\s+.*answer/gi,
    /i\s+will\s+write\s+the\s+answer/gi,
    /سأ?كتب لك الإجابة/gi,
    /سأ?صيغ لك الإجابة/gi,
    /يمكنني صياغة الإجابة/gi,
    /أستطيع كتابة إجابة/gi,
    /خليني أصيغ لك/gi,
    // Avoid meta prompts that derail flow
    /هل\s*هناك\s*سؤال\s*آخر\??/gi,
    /any\s*other\s*question\??/gi,
    /any\s*other\s*questions\??/gi,
    /anything\s*else\??/gi,
  ];
  badPhrases.forEach((re) => {
    out = out.replace(re, '');
  });
  // Keep replies short and professional
  out = out.trim();
  return out;
}

async function converseOnAnswer({ job, sessionDoc, question, message }) {
  const lang = job.language || 'ar';
  const finalPrompt = `You are Azzam, the company's hiring interviewer/evaluator.\n- Role: strictly interview and evaluate the candidate. Do NOT coach, write, or improve their answers.\n- Never say things like: "I can write a better answer" or "let me craft the answer" or any phrasing that offers to write on their behalf.\n- Focus only on evaluating what they wrote and asking targeted follow-up questions when needed.\n- Keep tone warm, short, and professional. Default to ${lang === 'ar' ? 'Arabic' : 'English'}.\n- Never repeat the full original question unless the action is "clarify" (and only once).\n\nClassify the user's message relative to the current question into exactly one of these actions:\n- answer: they gave a reasonable answer; acknowledge briefly.\n- clarify: they asked for clarification; provide a brief clarification and re-ask the full question once.\n- ask_again: partial or shallow answer; ask a brief, targeted follow-up (no full question).\n- guide: they asked a side question or went off-topic; guide briefly back with a short follow-up (no full question).\n\nRespond with strict JSON ONLY:\n{\n  "assistant_reply": "Short acknowledgment or clarification in ${lang === 'ar' ? 'Arabic' : 'English'}.",\n  "normalized_answer": "If action=answer, a concise normalized summary of their answer; otherwise null.",\n  "action": "answer" | "clarify" | "ask_again" | "guide",\n  "follow_up_question": "If action in ask_again/guide, a short follow-up question (without repeating the full original question); otherwise empty string."
}`;
  const messages = [
    { role: 'system', content: finalPrompt },
    { role: 'user', content: JSON.stringify({ job: { title: job.title }, question, previous_answers: sessionDoc.answers || [], candidate_message: message }) }
  ];
  try {
    if (!OPENAI_API_KEY) {
      console.error('[LLM] OpenAI key missing; cannot use gpt-4.1-nano');
      return { action:'ask_again', assistant_reply: '', normalized_answer: null };
    }
    console.log(`[LLM] converse using OpenAI ${OPENAI_MODEL}`);
    console.log('[LLM] Calling OpenAI with model:', process.env.OPENAI_MODEL);
    const resp = await axios.post('https://api.openai.com/v1/chat/completions',
      { model: OPENAI_MODEL, messages, temperature: 0.3 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    const raw = resp?.data?.choices?.[0]?.message?.content || '{}';
    let parsed; try { parsed = JSON.parse(raw); } catch(_) { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : {}; }
    return {
      assistant_reply: String(parsed.assistant_reply || ''),
      normalized_answer: parsed.normalized_answer ?? null,
      action: String(parsed.action || 'ask_again'),
      follow_up_question: String(parsed.follow_up_question || '')
    };
  } catch (e) {
    console.error('[LLM Error]', e?.response?.data || e?.message || e);
    return { action:'ask_again', assistant_reply: '', normalized_answer: null, follow_up_question: '' };
  }
}

// (legacy helpers removed)

async function analyzeCandidate(job, answers) {
  const questions = Array.isArray(job.questions) ? job.questions : [];
  // Align answers by index; sanitize meta/non-answers to empty strings
  const qa = questions.map((q, i) => {
    const a = (answers || [])[i]?.answer || '';
    const ans = isValidAnswerContent(a) ? a : '';
    return { question: q, answer: ans };
  });
  const sys = {
    role: 'system',
    content: (job.language||'en')==='ar'
      ? 'أنت مُقابِل تقني متمرس. قيّم المرشح بعدالة وفق معايير واضحة، وأعد JSON صارم فقط. استخدم مقياس 0–100 حيث 100 ممتاز. عاير الدرجات إنسانيًا: المرشح المتوسط بين 55–85 غالبًا. طبّق محاور التقييم بالأوزان: الوضوح 25%، الملاءمة 35%، الاكتمال 25%، عمق الخبرة 15%. ثم احسب decision وفق العتبات: accept إذا score ≥ 75، review إذا 60–74، reject إذا < 60. إذا كانت أي إجابة فارغة فاعتبرها غير مُجاب عنها وامِل إلى قرار review. أعد JSON فقط.'
      : 'You are a senior technical interviewer. Score fairly with a human-calibrated 0–100 scale (100 = excellent). Typical average candidates should land around 55–85 unless answers are truly poor. Use weighted rubric: clarity 25%, relevance 35%, completeness 25%, experience-depth 15%. Then set decision by thresholds: accept if score ≥ 75; review if 60–74; reject if < 60. If any answer is empty treat it as unanswered and lean toward review. Return strict JSON only.'
  };

  const user = {
    role: 'user',
    content: (job.language||'en')==='ar'
      ? `قيّم هذا المرشح بناءً على تفاصيل الدور التالية وإجابات المرشح المقابلة لكل سؤال فقط.\n\nالأسئلة:\n${questions.map((q,i)=>`س${i+1}: ${q}`).join('\n')}\n\nإجابات المرشح (قد تكون فارغة إذا لم يجب):\n${qa.map((x,i)=>`ج${i+1}: ${x.answer}`).join('\n')}\n\nأعد JSON فقط بالشكل:\n{\n  "score": number,\n  "strengths": [],\n  "weaknesses": [],\n  "decision": "accept" | "reject" | "review",\n  "summary": ""\n}`
      : `Evaluate strictly based on these Q/A pairs only (answers may be empty if unanswered).\n\nQUESTIONS:\n${questions.map((q,i)=>`Q${i+1}: ${q}`).join('\n')}\n\nAPPLICANT ANSWERS:\n${qa.map((x,i)=>`A${i+1}: ${x.answer}`).join('\n')}\n\nReturn strict JSON:\n{\n  "score": number,\n  "strengths": [],\n  "weaknesses": [],\n  "decision": "accept" | "reject" | "review",\n  "summary": ""\n}`
  };

  try {
    if (!OPENAI_API_KEY) {
      console.error('[LLM] OpenAI key missing; cannot analyze with gpt-4.1-nano');
      throw new Error('OpenAI key missing');
    }
    console.log(`[LLM] analyze using OpenAI ${OPENAI_MODEL}`);
    console.log('[LLM] Calling OpenAI with model:', process.env.OPENAI_MODEL);
    const resp = await axios.post('https://api.openai.com/v1/chat/completions',
      { model: OPENAI_MODEL, messages: [sys, user], temperature: 0.2 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
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
    // Standardized decision mapping (server-authoritative)
    let decision;
    if (score >= 85) decision = 'strong';
    else if (score >= 75) decision = 'recommended';
    else if (score >= 60) decision = 'review';
    else decision = 'weak';
    // If any answers were empty, lean to review
    const anyMissing = qa.some(x => !x.answer || !x.answer.trim());
    if (anyMissing && (decision === 'strong' || decision === 'recommended')) {
      decision = 'review';
    }
    return {
      score,
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : (parsed.strengths ? [String(parsed.strengths)] : []),
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : (parsed.weaknesses ? [String(parsed.weaknesses)] : []),
      decision,
      summary: String(parsed.summary || '')
    };
  } catch (err) {
    console.error('[LLM Error]', err?.response?.data || err?.message || err);
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
      applicantEmail: sessionDoc.applicantEmail || undefined,
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
    // Create session only on readiness; otherwise send intro
    if (!isStart) {
      await sendWhatsApp(fromWa, buildWelcomeMessage(job));
      return res.send('OK');
    }
    if (dbReady) {
      sessionDoc = await Session.create({ applicantPhone: from, jobId: job.jobId, currentIndex: 0, answers: [], processedMessageSids: [], interviewStarted: true, pendingQuestion: (job.questions||[])[0] || '', followUpCounts: [], needsReview: [] });
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
    // Heuristic classification: readiness starts Q1 if not started
    if (!sessionDoc.interviewStarted && isStartMessage(job, message)) {
      sessionDoc.interviewStarted = true;
      if (dbReady) await sessionDoc.save();
      await sendWhatsApp(fromWa, t((job.language||'en'),'whatsapp.question_prefix', { current: 1, total: job.questions.length, question: q }));
      return res.send('OK');
    }
    // Confirmation-only while waiting → ignore to avoid blocking or repetition
    if (isConfirmationOnly(message)) {
      if (dbReady) await sessionDoc.save();
      return res.send('OK');
    }
    // Clarification intent shortcut
    if (isClarification(message)) {
      const guidance = await converseOnAnswer({ job, sessionDoc, question: q, message });
      let reply = sanitizeAssistantReply(guidance?.assistant_reply || '', job.language);
      if (reply) await sendWhatsApp(fromWa, reply);
      // Re-ask once only
      await sendWhatsApp(fromWa, t((job.language||'en'),'whatsapp.question_prefix', { current: idx+1, total: job.questions.length, question: q }));
      return res.send('OK');
    }
    // User question → guide politely
    if (isUserQuestion(message) && !isProbablyAnswer(message)) {
      const guidance = await converseOnAnswer({ job, sessionDoc, question: q, message });
      let reply = sanitizeAssistantReply(guidance?.assistant_reply || '', job.language);
      const fu = guidance?.follow_up_question ? sanitizeAssistantReply(guidance.follow_up_question, job.language) : '';
      const out = [reply, fu].filter(Boolean).join('\n');
      if (out) await sendWhatsApp(fromWa, out);
      // Count follow-up; do NOT repeat full question here
      sessionDoc.followUpCounts = Array.isArray(sessionDoc.followUpCounts) ? sessionDoc.followUpCounts : [];
      sessionDoc.followUpCounts[idx] = (sessionDoc.followUpCounts[idx] || 0) + 1;
      const reachedLimit = sessionDoc.followUpCounts[idx] >= MAX_FOLLOW_UPS;
      if (reachedLimit) {
        sessionDoc.needsReview = Array.isArray(sessionDoc.needsReview) ? sessionDoc.needsReview : [];
        if (!sessionDoc.needsReview.includes(idx)) sessionDoc.needsReview.push(idx);
        sessionDoc.currentIndex = idx + 1;
      }
      if (dbReady) await sessionDoc.save();
      return res.send('OK');
    }
    // Default: use model to decide
    const guidance = await converseOnAnswer({ job, sessionDoc, question: q, message });
    const action = guidance?.action || 'ask_again';
    let reply = sanitizeAssistantReply(guidance?.assistant_reply || '', job.language);
    if (action === 'answer') {
      // Store the candidate's raw message if it is a valid answer (not meta/confirmation)
      const ans = message;
      if (!isValidAnswerContent(ans)) {
        // Treat as non-answer: re-ask full question
        const reask = t((job.language||'en'),'whatsapp.question_prefix', { current: idx+1, total: job.questions.length, question: q });
        if (reply) await sendWhatsApp(fromWa, reply);
        await sendWhatsApp(fromWa, reask);
        return res.send('OK');
      }
      sessionDoc.answers = sessionDoc.answers || [];
      if (sessionDoc.answers.length === idx) {
        sessionDoc.answers.push({ question: q, answer: ans });
      } else if (sessionDoc.answers.length < idx) {
        while (sessionDoc.answers.length < idx) sessionDoc.answers.push({ question: '', answer: '' });
        sessionDoc.answers.push({ question: q, answer: ans });
      } // Do not overwrite if length > idx (answer already finalized)
      const isLast = idx === (job.questions || []).length - 1;
      sessionDoc.currentIndex = idx + 1;
      if (isLast) {
        // Finalize immediately: send feedback + final closing in one message
        const finalMsg = buildFinalMessage(job);
        const out = [reply, finalMsg].filter(Boolean).join('\n');
        sessionDoc.completedAt = new Date();
        if (dbReady) await sessionDoc.save();
        try { await finalizeAndNotify(job, sessionDoc); } catch(_) {}
        if (out) await sendWhatsApp(fromWa, out);
        return res.send('OK');
      }
      if (dbReady) await sessionDoc.save();
      // Send feedback then immediately next question
      if (reply) await sendWhatsApp(fromWa, reply);
      if (sessionDoc.currentIndex < job.questions.length) {
        const nextIdx = sessionDoc.currentIndex;
        await sendWhatsApp(fromWa, t((job.language||'en'),'whatsapp.question_prefix', { current: nextIdx+1, total: job.questions.length, question: job.questions[nextIdx] }));
      }
      return res.send('OK');
    } else {
      // If action in ask_again/guide but user message is a valid answer, treat it as answer and advance
      if ((action === 'ask_again' || action === 'guide') && isValidAnswerContent(message)) {
        const ans = message;
        sessionDoc.answers = sessionDoc.answers || [];
        if (sessionDoc.answers.length === idx) {
          sessionDoc.answers.push({ question: q, answer: ans });
        } else if (sessionDoc.answers.length < idx) {
          while (sessionDoc.answers.length < idx) sessionDoc.answers.push({ question: '', answer: '' });
          sessionDoc.answers.push({ question: q, answer: ans });
        }
        const isLast = idx === (job.questions || []).length - 1;
        sessionDoc.currentIndex = idx + 1;
        if (isLast) {
          const finalMsg = buildFinalMessage(job);
          const out = [reply, finalMsg].filter(Boolean).join('\n');
          sessionDoc.completedAt = new Date();
          if (dbReady) await sessionDoc.save();
          try { await finalizeAndNotify(job, sessionDoc); } catch(_) {}
          if (out) await sendWhatsApp(fromWa, out);
          return res.send('OK');
        }
        if (dbReady) await sessionDoc.save();
        // Acknowledge briefly then move on
        if (reply) await sendWhatsApp(fromWa, reply);
        if (sessionDoc.currentIndex < job.questions.length) {
          const nextIdx = sessionDoc.currentIndex;
          await sendWhatsApp(fromWa, t((job.language||'en'),'whatsapp.question_prefix', { current: nextIdx+1, total: job.questions.length, question: job.questions[nextIdx] }));
        }
        return res.send('OK');
      } else {
        // For clarify → re-ask once; for ask_again/guide → only send short follow-up
        const fu = guidance?.follow_up_question ? sanitizeAssistantReply(guidance.follow_up_question, job.language) : '';
        const out = [reply, fu].filter(Boolean).join('\n');
        if (out) await sendWhatsApp(fromWa, out);
        // Track follow-up counts and advance if limit reached
        sessionDoc.followUpCounts = Array.isArray(sessionDoc.followUpCounts) ? sessionDoc.followUpCounts : [];
        sessionDoc.followUpCounts[idx] = (sessionDoc.followUpCounts[idx] || 0) + 1;
        const reachedLimit = sessionDoc.followUpCounts[idx] >= MAX_FOLLOW_UPS;
        if (action === 'clarify') {
          // Clarify: re-ask full question exactly once
          await sendWhatsApp(fromWa, t((job.language||'en'),'whatsapp.question_prefix', { current: idx+1, total: job.questions.length, question: q }));
        }
        if (reachedLimit) {
          sessionDoc.needsReview = Array.isArray(sessionDoc.needsReview) ? sessionDoc.needsReview : [];
          if (!sessionDoc.needsReview.includes(idx)) sessionDoc.needsReview.push(idx);
          sessionDoc.currentIndex = idx + 1;
        }
        if (dbReady) await sessionDoc.save();
        return res.send('OK');
      }
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
    // mark as sent
    created.sentRecipients = Array.from(new Set([...(created.sentRecipients||[]), ...(created.candidateRecipients||[])]));
    await created.save();
    return res.json({ ok: true, job: created });
  } else {
    doc.sentRecipients = Array.from(new Set([...(doc.sentRecipients||[]), ...(doc.candidateRecipients||[])]));
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

// HR API: delete job (and related sessions/submissions)
app.delete('/api/jobs/:jobId', async (req, res) => {
  const jobId = req.params.jobId;
  if (dbReady) {
    const job = await Job.findOne({ jobId });
    if (!job) return res.status(404).json({ error: 'Not found' });
    await Promise.all([
      Job.deleteOne({ jobId }),
      Session.deleteMany({ jobId }),
      Submission.deleteMany({ jobId })
    ]);
    return res.json({ ok: true });
  } else {
    if (!fallbackJobs.has(jobId)) return res.status(404).json({ error: 'Not found' });
    fallbackJobs.delete(jobId);
    return res.json({ ok: true, warning: 'No DB configured; removed from memory only.' });
  }
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
    job.sentRecipients = Array.from(new Set([...(job.sentRecipients||[]), ...newOnly]));
    await job.save();
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
    job.sentRecipients = Array.from(new Set([...(job.sentRecipients||[]), ...newOnly]));
    return res.json({ ok: true, job, warning: 'No DB configured; in-memory update only.' });
  }
});

// HR API: (re)send job announcement to candidates
// Body: { mode: 'all' | 'new' }
app.post('/api/jobs/:jobId/send', async (req, res) => {
  const jobId = req.params.jobId;
  const mode = (req.body && req.body.mode) || 'new';
  if (!dbReady) return res.status(400).json({ error: 'DB required for send workflow' });
  const job = await Job.findOne({ jobId });
  if (!job) return res.status(404).json({ error: 'Not found' });
  const all = Array.isArray(job.candidateRecipients) ? job.candidateRecipients.map(String) : [];
  const sentSet = new Set((job.sentRecipients || []).map(s => s.trim()));
  const targets = mode === 'all' ? all : all.filter(p => !sentSet.has(p.trim()));
  const msg = buildWelcomeMessage(job);
  let success = 0;
  for (const r of targets) {
    const to = toWhatsApp(r);
    if (!to) continue;
    const result = await sendWhatsApp(to, msg);
    if (result) success++;
  }
  // Update flags regardless of per-message success to avoid hammering blocks; can be refined if needed
  const union = Array.from(new Set([...(job.sentRecipients || []), ...targets]));
  job.sentRecipients = union;
  await job.save();
  return res.json({ ok: true, sent: targets.length, success });
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
app.get('/health', (req, res) => res.status(200).send('OK'));

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

// =========================
// Dev: Web Interview (local)
// =========================
// POST /api/interview/start
// Body: { email: string, jobId?: string }
// Behavior: if email === 'baseelaziz1@gmail.com' -> create a session and return a URL; else no-op
app.post('/api/interview/start', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const jobId = req.body && req.body.jobId ? String(req.body.jobId).trim() : null;
    // Only allow the specific dev email
    if (email !== 'baseelaziz1@gmail.com') {
      return res.json({ ok: false, ignored: true });
    }

    // Resolve job
    let job = null;
    if (dbReady) {
      job = jobId
        ? await Job.findOne({ jobId }).lean()
        : await Job.findOne({}).sort({ createdAt: -1 }).lean();
    }
    if (!job) {
      const [single] = fallbackJobs.values();
      if (!single) return res.status(400).json({ error: 'No active job configured' });
      job = single;
    }

    // Create a new session (same structure as WhatsApp flow)
    let sessionDoc = null;
    if (dbReady) {
      sessionDoc = await Session.create({
        applicantPhone: `email:${email}`,
        applicantEmail: email,
        jobId: job.jobId,
        currentIndex: 0,
        answers: [],
        processedMessageSids: [],
        interviewStarted: false,
        pendingQuestion: (job.questions || [])[0] || '',
        conversationHistory: [
          { role: 'assistant', content: buildWelcomeMessage(job) }
        ]
      });
    } else {
      // No DB mode: cannot persist sessions -> return mock URL with a random id
      const fakeId = Math.random().toString(36).slice(2);
      return res.json({ ok: true, url: `/interview/${fakeId}`, warning: 'DB not configured; session is not persisted.' });
    }

    return res.json({ ok: true, url: `/interview/${sessionDoc._id}` });
  } catch (e) {
    console.error('web interview start error', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/interview/session/:id -> loads session + job + history
app.get('/api/interview/session/:id', async (req, res) => {
  if (!dbReady) return res.status(400).json({ error: 'DB required for web interview' });
  const id = req.params.id;
  const sessionDoc = await Session.findById(id).lean();
  if (!sessionDoc) return res.status(404).json({ error: 'Not found' });
  const job = await Job.findOne({ jobId: sessionDoc.jobId }).lean();
  return res.json({
    ok: true,
    session: {
      id: String(sessionDoc._id),
      jobId: sessionDoc.jobId,
      currentIndex: sessionDoc.currentIndex || 0,
      interviewStarted: !!sessionDoc.interviewStarted,
      completedAt: sessionDoc.completedAt || null,
    },
    job: { jobId: job?.jobId, title: job?.title, language: job?.language, total: (job?.questions || []).length },
    history: Array.isArray(sessionDoc.conversationHistory) ? sessionDoc.conversationHistory : []
  });
});

// POST /api/interview/webhook
// Body: { sessionId: string, message: string }
// Reuses WhatsApp flow logic, returns assistant reply as JSON
app.post('/api/interview/webhook', async (req, res) => {
  try {
    if (!dbReady) return res.status(400).json({ error: 'DB required for web interview' });
    const sessionId = String((req.body && req.body.sessionId) || '').trim();
    const message = String((req.body && req.body.message) || '').trim();
    if (!sessionId || !message) return res.status(400).json({ error: 'sessionId and message are required' });

    const sessionDoc = await Session.findById(sessionId);
    if (!sessionDoc) return res.status(404).json({ error: 'Session not found' });
    const job = await Job.findOne({ jobId: sessionDoc.jobId }).lean();
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Maintain conversation history
    sessionDoc.conversationHistory = Array.isArray(sessionDoc.conversationHistory) ? sessionDoc.conversationHistory : [];
    sessionDoc.conversationHistory.push({ role: 'user', content: message });

    const normalizedMsg = message.normalize('NFKC').toLowerCase();
    const isStart = isStartMessage(job, normalizedMsg);

    // If session not started yet
    if (!sessionDoc.interviewStarted) {
      if (!isStart) {
        const welcome = buildWelcomeMessage(job);
        sessionDoc.conversationHistory.push({ role: 'assistant', content: welcome });
        sessionDoc.markModified('conversationHistory');
        await sessionDoc.save();
        return res.json({ ok: true, reply: welcome, state: { currentIndex: sessionDoc.currentIndex, started: false } });
      }
      sessionDoc.interviewStarted = true;
      // Ask first question
      const q = (job.questions || [])[0];
      const prompt = q ? t((job.language || 'en'), 'whatsapp.question_prefix', { current: 1, total: (job.questions || []).length, question: q }) : t((job.language || 'en'), 'whatsapp.no_questions');
      sessionDoc.conversationHistory.push({ role: 'assistant', content: prompt });
      await sessionDoc.save();
      return res.json({ ok: true, reply: prompt, state: { currentIndex: 0, started: true } });
    }

    // Conversational handling for current question
    const idx = sessionDoc.currentIndex || 0;
    if (idx < (job.questions || []).length) {
      const q = job.questions[idx];

      // Confirmation-only while waiting → ignore so it doesn't block or repeat
      if (isConfirmationOnly(message)) {
        await sessionDoc.save();
        return res.json({ ok: true, reply: '', state: { currentIndex: sessionDoc.currentIndex, started: true } });
      }

      // Clarification intent shortcut
      if (isClarification(message)) {
        const guidance = await converseOnAnswer({ job, sessionDoc, question: q, message });
        const reply = sanitizeAssistantReply(guidance?.assistant_reply || '', job.language);
        if (reply) sessionDoc.conversationHistory.push({ role: 'assistant', content: reply });
        // Re-ask once
        const reask = t((job.language || 'en'), 'whatsapp.question_prefix', { current: idx + 1, total: job.questions.length, question: q });
        sessionDoc.conversationHistory.push({ role: 'assistant', content: reask });
        sessionDoc.markModified('conversationHistory');
        await sessionDoc.save();
        return res.json({ ok: true, reply: reply || reask, state: { currentIndex: idx, started: true } });
      }

      // User asks question → guide politely
      if (isUserQuestion(message) && !isProbablyAnswer(message)) {
        const guidance = await converseOnAnswer({ job, sessionDoc, question: q, message });
        const reply = sanitizeAssistantReply(guidance?.assistant_reply || '', job.language);
        const fu = guidance?.follow_up_question ? sanitizeAssistantReply(guidance.follow_up_question, job.language) : '';
        const out = [reply, fu].filter(Boolean).join('\n');
        if (out) sessionDoc.conversationHistory.push({ role: 'assistant', content: out });
        // Count follow-up and do not repeat full question
        sessionDoc.followUpCounts = Array.isArray(sessionDoc.followUpCounts) ? sessionDoc.followUpCounts : [];
        sessionDoc.followUpCounts[idx] = (sessionDoc.followUpCounts[idx] || 0) + 1;
        const reachedLimit = sessionDoc.followUpCounts[idx] >= MAX_FOLLOW_UPS;
        if (reachedLimit) {
          sessionDoc.needsReview = Array.isArray(sessionDoc.needsReview) ? sessionDoc.needsReview : [];
          if (!sessionDoc.needsReview.includes(idx)) sessionDoc.needsReview.push(idx);
          sessionDoc.currentIndex = idx + 1;
        }
        sessionDoc.markModified('conversationHistory');
        await sessionDoc.save();
        return res.json({ ok: true, reply: out, state: { currentIndex: sessionDoc.currentIndex, started: true } });
      }

      // Default: use model to decide
      const guidance = await converseOnAnswer({ job, sessionDoc, question: q, message });
      const action = guidance?.action || 'ask_again';
      const reply = sanitizeAssistantReply(guidance?.assistant_reply || '', job.language);
      if (action === 'answer') {
        // Store the candidate's raw message only if valid answer (not meta/confirmation)
        const ans = message;
        if (!isValidAnswerContent(ans)) {
          // Re-ask full question; do not advance or store
          const reask = t((job.language || 'en'), 'whatsapp.question_prefix', { current: idx + 1, total: job.questions.length, question: q });
          const out = [reply, reask].filter(Boolean).join('\n');
          if (out) sessionDoc.conversationHistory.push({ role: 'assistant', content: out });
          sessionDoc.markModified('conversationHistory');
          await sessionDoc.save();
          return res.json({ ok: true, reply: out, state: { currentIndex: idx, started: true } });
        }
        sessionDoc.answers = sessionDoc.answers || [];
        if (sessionDoc.answers.length === idx) {
          sessionDoc.answers.push({ question: q, answer: ans });
        } else if (sessionDoc.answers.length < idx) {
          while (sessionDoc.answers.length < idx) sessionDoc.answers.push({ question: '', answer: '' });
          sessionDoc.answers.push({ question: q, answer: ans });
        }
        const isLast = idx === (job.questions || []).length - 1;
        sessionDoc.currentIndex = idx + 1;
        let out;
        if (isLast) {
          const finalMsg = buildFinalMessage(job);
          out = [reply, finalMsg].filter(Boolean).join('\n');
          sessionDoc.completedAt = new Date();
          sessionDoc.conversationHistory.push({ role: 'assistant', content: out });
          sessionDoc.markModified('conversationHistory');
          await sessionDoc.save();
          const { analysis } = await finalizeAndNotify(job, { ...sessionDoc.toObject(), from: sessionDoc.applicantEmail || sessionDoc.applicantPhone });
          return res.json({ ok: true, reply: out, done: true, analysis });
        }
        // Not last: feedback + next question in one turn
        const nextIdx = sessionDoc.currentIndex;
        const prompt = t((job.language || 'en'), 'whatsapp.question_prefix', { current: nextIdx + 1, total: job.questions.length, question: job.questions[nextIdx] });
        out = [reply, prompt].filter(Boolean).join('\n');
        if (out) sessionDoc.conversationHistory.push({ role: 'assistant', content: out });
        sessionDoc.markModified('conversationHistory');
        await sessionDoc.save();
        return res.json({ ok: true, reply: out, state: { currentIndex: nextIdx, started: true } });
      } else {
        if ((action === 'ask_again' || action === 'guide') && isValidAnswerContent(message)) {
          const ans = message;
          sessionDoc.answers = sessionDoc.answers || [];
          if (sessionDoc.answers.length === idx) {
            sessionDoc.answers.push({ question: q, answer: ans });
          } else {
            while (sessionDoc.answers.length < idx) sessionDoc.answers.push({ question: '', answer: '' });
            sessionDoc.answers.push({ question: q, answer: ans });
          }
          const isLast = idx === (job.questions || []).length - 1;
          sessionDoc.currentIndex = idx + 1;
          if (isLast) {
            const finalMsg = buildFinalMessage(job);
            const out = [reply, finalMsg].filter(Boolean).join('\n');
            sessionDoc.completedAt = new Date();
            sessionDoc.conversationHistory.push({ role: 'assistant', content: out });
            sessionDoc.markModified('conversationHistory');
            await sessionDoc.save();
            const { analysis } = await finalizeAndNotify(job, { ...sessionDoc.toObject(), from: sessionDoc.applicantEmail || sessionDoc.applicantPhone });
            return res.json({ ok: true, reply: out, done: true, analysis });
          }
          // Not last: ack + next question
          const nextIdx = sessionDoc.currentIndex;
          const prompt = t((job.language || 'en'), 'whatsapp.question_prefix', { current: nextIdx + 1, total: job.questions.length, question: job.questions[nextIdx] });
          const out = [reply, prompt].filter(Boolean).join('\n');
          if (out) sessionDoc.conversationHistory.push({ role: 'assistant', content: out });
          sessionDoc.markModified('conversationHistory');
          await sessionDoc.save();
          return res.json({ ok: true, reply: out, state: { currentIndex: nextIdx, started: true } });
        } else {
          const fu = guidance?.follow_up_question ? sanitizeAssistantReply(guidance.follow_up_question, job.language) : '';
          const out = [reply, fu].filter(Boolean).join('\n');
          if (out) sessionDoc.conversationHistory.push({ role: 'assistant', content: out });
          // Clarify: re-ask full question once
          if (action === 'clarify') {
            const reask = t((job.language || 'en'), 'whatsapp.question_prefix', { current: idx + 1, total: job.questions.length, question: q });
            sessionDoc.conversationHistory.push({ role: 'assistant', content: reask });
          }
          // Follow-up counting and limit
          sessionDoc.followUpCounts = Array.isArray(sessionDoc.followUpCounts) ? sessionDoc.followUpCounts : [];
          sessionDoc.followUpCounts[idx] = (sessionDoc.followUpCounts[idx] || 0) + 1;
          const reachedLimit = sessionDoc.followUpCounts[idx] >= MAX_FOLLOW_UPS;
          if (reachedLimit) {
            sessionDoc.needsReview = Array.isArray(sessionDoc.needsReview) ? sessionDoc.needsReview : [];
            if (!sessionDoc.needsReview.includes(idx)) sessionDoc.needsReview.push(idx);
            sessionDoc.currentIndex = idx + 1;
          }
          sessionDoc.markModified('conversationHistory');
          await sessionDoc.save();
          return res.json({ ok: true, reply: out, state: { currentIndex: sessionDoc.currentIndex, started: true } });
        }
      }
    }

    // Ask next or finalize
    if (sessionDoc.currentIndex < (job.questions || []).length) {
      const nextIdx = sessionDoc.currentIndex;
      const prompt = t((job.language || 'en'), 'whatsapp.question_prefix', { current: nextIdx + 1, total: job.questions.length, question: job.questions[nextIdx] });
      sessionDoc.conversationHistory.push({ role: 'assistant', content: prompt });
      sessionDoc.markModified('conversationHistory');
      await sessionDoc.save();
      return res.json({ ok: true, reply: prompt, state: { currentIndex: nextIdx, started: true } });
    }

    // Finalize
    if (!sessionDoc.completedAt) {
      sessionDoc.completedAt = new Date();
      await sessionDoc.save();
      const { analysis } = await finalizeAndNotify(job, { ...sessionDoc.toObject(), from: sessionDoc.applicantEmail || sessionDoc.applicantPhone });
      const finalMsg = buildFinalMessage(job);
      sessionDoc.conversationHistory.push({ role: 'assistant', content: finalMsg });
      sessionDoc.markModified('conversationHistory');
      await sessionDoc.save();
      return res.json({ ok: true, reply: finalMsg, done: true, analysis });
    }

    // Already completed
    return res.json({ ok: true, reply: buildFinalMessage(job), done: true });
  } catch (e) {
    console.error('web interview webhook error', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Serve lightweight React Admin (via CDN)
app.use(express.static('public'));
// Serve locales for Admin UI i18n
app.use('/locales', express.static('locales'));
app.get(['/','/admin'], (_, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
});

// Serve web interview page
app.get('/interview/:id', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'interview.html'));
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Running on port ${PORT}`);
});
// Expose for signal handlers
global.__server = server;
// Tune timeouts for proxy compatibility
try {
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
} catch {}
server.on('error', (e) => {
  console.error('[Server Error]', e && (e.stack || e.message || e));
});
