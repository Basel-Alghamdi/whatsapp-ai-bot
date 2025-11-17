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
    aiStrengths: String,
    aiWeaknesses: String,
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
  return `Hi 👋\nI'm Azzam the AI assistant, you apply for the job ${job.title} and I want to ask you some questions that help the team to know you more.\nIf you are ready then send start to begin.\nNote: Any question must have only one answer, more than one answer will be not accepted`;
}

// (legacy helpers removed)

async function analyzeCandidate(job, answers) {
  const qa = answers.map(a => ({ question: a.question, answer: a.answer }));
  const sys = {
    role: 'system',
    content: 'You are a senior technical interviewer. Be concise, fair, and specific. Always return strict JSON and nothing else.'
  };

  const user = {
    role: 'user',
    content: `You are a senior technical interviewer. Evaluate this applicant strictly based on the role below.\n\nROLE DETAILS:\nTitle: ${job.title}\nDescription: ${job.description || ''}\nResponsibilities: ${job.responsibilities || ''}\nRequirements: ${job.requirements || ''}\nSkills: ${job.skills || ''}\nBenefits: ${job.benefits || ''}\n\nAPPLICANT ANSWERS:\n${qa.map((x,i)=>`Q${i+1}: ${x.question}\nA${i+1}: ${x.answer}`).join('\n')}\n\nEvaluate and return a JSON with:\n{\n  "score": "number from 0 to 100",\n  "strengths": "bullet points",\n  "weaknesses": "bullet points",\n  "decision": "Hire / Maybe / Reject",\n  "summary": "one short paragraph"\n}`
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
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('Failed to parse JSON from Groq response');
      }
    }
    return parsed;
  } catch (err) {
    console.error('Groq error:', err?.response?.data || err.message);
    return { score: 0, strengths: '', weaknesses: '', decision: 'Maybe', summary: 'AI analysis failed; manual review required.' };
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
      aiStrengths: String(analysis.strengths || ''),
      aiWeaknesses: String(analysis.weaknesses || ''),
      aiDecision: String(analysis.decision || 'Maybe'),
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

  // Start phrase recognition (Arabic "ابدأ عزّام" or English 'start')
  const normalizedMsg = message.normalize('NFKC').toLowerCase();
  const isStart = /ابد|ابدا|ابدأ|start/.test(normalizedMsg);

  if (!sessionDoc) {
    if (!isStart) {
      await sendWhatsApp(fromWa, `للبدء اكتب: ابدأ عزّام\nTo start, type: start`);
      return res.send('OK');
    }
    if (dbReady) {
      sessionDoc = await Session.create({ applicantPhone: from, jobId: job.jobId, currentIndex: 0, answers: [], processedMessageSids: [] });
    }
    // Intro + first question
    await sendWhatsApp(fromWa, `مرحبا! Welcome to ${job.title} assessment. I will ask ${job.questions.length} questions.`);
    await sendWhatsApp(fromWa, `Q1/${job.questions.length}: ${job.questions[0]}`);
    return res.send('OK');
  }

  // Idempotency for DB sessions
  if (dbReady && messageSid) {
    if (sessionDoc.processedMessageSids.includes(messageSid)) return res.send('OK');
    sessionDoc.processedMessageSids.push(messageSid);
  }

  // Record first answer for current question only
  const idx = sessionDoc.currentIndex || 0;
  if (idx < job.questions.length) {
    if ((sessionDoc.answers || []).length === idx) {
      sessionDoc.answers.push({ question: job.questions[idx], answer: message });
      sessionDoc.currentIndex = idx + 1;
      if (dbReady) await sessionDoc.save();
    }
  }

  // Ask next or finalize
  if (sessionDoc.currentIndex < job.questions.length) {
    const nextIdx = sessionDoc.currentIndex;
    await sendWhatsApp(fromWa, `Q${nextIdx + 1}/${job.questions.length}: ${job.questions[nextIdx]}`);
    return res.send('OK');
  }

  // Finalize
  if (!sessionDoc.completedAt) {
    sessionDoc.completedAt = new Date();
    if (dbReady) await sessionDoc.save();
    await finalizeAndNotify(job, sessionDoc);
    await sendWhatsApp(fromWa, 'Thank you for applying, wishing you all the best 👏');
  }
  return res.send('OK');
});

// HR API: create job
app.post('/api/jobs', async (req, res) => {
  const { title, description, responsibilities, requirements, skills, benefits, questions, recipients } = req.body || {};
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'title and questions[] are required' });
  }
  const doc = {
    jobId: generateJobId(),
    title,
    description: description || '',
    responsibilities: responsibilities || '',
    requirements: requirements || '',
    skills: skills || '',
    benefits: benefits || '',
    questions: questions.map(String),
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
    brandName: process.env.BRAND_NAME || 'Azzam ATS • Admin'
  });
});

// Serve lightweight React Admin (via CDN)
app.use(express.static('public'));
app.get(['/','/admin'], (_, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
