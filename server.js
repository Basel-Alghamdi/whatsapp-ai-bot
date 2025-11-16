require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

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

// In-memory stores (swap to Redis/DB in production)
const jobs = new Map(); // jobId -> { id, title, introMessage, closingMessage, questions: [{id,text,weight,rubric}], hrWebhook }
const sessions = new Map(); // candidateKey(phone|jobId) -> session

// Seed sample job for quick start (can be replaced via POST /jobs)
(function seedSampleJob() {
  const id = 'JOB-DEMO';
  if (!jobs.has(id)) {
    jobs.set(id, {
      id,
      title: 'Junior Backend Engineer',
      introMessage: 'Thanks for applying to Junior Backend Engineer. I will ask you a few quick questions.',
      closingMessage: 'Thanks! We have recorded your responses. You will hear from us soon.',
      hrWebhook: process.env.HR_WEBHOOK_URL || '',
      questions: [
        { id: 'q1', text: 'Briefly introduce yourself and your experience.', weight: 1 },
        { id: 'q2', text: 'What programming languages and frameworks are you most comfortable with?', weight: 2 },
        { id: 'q3', text: 'Describe a challenging backend problem you solved and how.', weight: 3 },
        { id: 'q4', text: 'What are your salary expectations and notice period?', weight: 1 }
      ]
    });
  }
})();

// Helpers
function candidateKey(from, jobId) {
  return `${from}|${jobId}`;
}

function newSession({ from, jobId }) {
  const id = `S_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sess = {
    id,
    jobId,
    from,
    currentIndex: 0,
    answers: [], // { qid, question, answer, ts }
    startedAt: new Date().toISOString(),
    completedAt: null,
    processedMessageSids: new Set(),
    analysis: null
  };
  sessions.set(candidateKey(from, jobId), sess);
  return sess;
}

async function sendWhatsApp(to, body) {
  return client.messages.create({ from: twilioFrom, to, body });
}

function parseJobCodeFromMessage(message) {
  if (!message) return null;
  // Expect formats like: "apply JOB-DEMO" or "JOB-DEMO"
  const tokenized = message.trim().toUpperCase().split(/\s+/);
  if (tokenized.length === 1) return tokenized[0];
  if (tokenized[0] === 'APPLY' && tokenized[1]) return tokenized[1];
  return null;
}

function getOrAskForJob({ message }) {
  // If only one job, default to it
  if (jobs.size === 1) {
    const [single] = jobs.values();
    return { job: single, needJobCode: false };
  }
  const code = parseJobCodeFromMessage(message);
  if (code && jobs.has(code)) return { job: jobs.get(code), needJobCode: false };
  return { job: null, needJobCode: true };
}

function transcriptFromSession(sess) {
  return sess.answers.map(a => ({ question: a.question, answer: a.answer }));
}

async function analyzeCandidate(job, sess) {
  const transcript = transcriptFromSession(sess);
  const prompt = {
    role: 'system',
    content: `You are an ATS assistant. You will score a candidate between 0 and 100 based on the job and answers. Be fair, concise, specific. Output a strict JSON object with fields: overall_score_percent (0-100), strengths (array of strings), weaknesses (array of strings), per_question (array of {id, question, score_0_100, notes}), decision (one of: strong_yes, yes, maybe, no), summary (short paragraph).`
  };

  const user = {
    role: 'user',
    content: JSON.stringify({ job: { id: job.id, title: job.title, questions: job.questions }, transcript })
  };

  try {
    const resp = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: GROQ_MODEL,
        messages: [prompt, user],
        temperature: 0.2,
      },
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
    return {
      overall_score_percent: 0,
      strengths: [],
      weaknesses: [],
      per_question: transcript.map((qa, idx) => ({ id: job.questions[idx]?.id || `q${idx+1}`, question: qa.question, score_0_100: 0, notes: 'Scoring failed' })),
      decision: 'maybe',
      summary: 'AI analysis failed; manual review required.'
    };
  }
}

async function finalizeAndNotify(job, sess) {
  const analysis = await analyzeCandidate(job, sess);
  sess.analysis = analysis;
  sess.completedAt = new Date().toISOString();

  // Notify HR via webhook if configured
  if (job.hrWebhook) {
    try {
      await axios.post(job.hrWebhook, {
        sessionId: sess.id,
        jobId: job.id,
        candidate: { phone: sess.from },
        transcript: transcriptFromSession(sess),
        analysis
      }, { timeout: 5000 });
    } catch (e) {
      console.warn('HR webhook post failed:', e.message);
    }
  }

  const summaryLines = [
    `Overall score: ${analysis.overall_score_percent}%`,
    `Decision: ${analysis.decision}`,
    `Top strengths: ${analysis.strengths?.slice(0,3).join('; ') || '—'}`,
    `Top weaknesses: ${analysis.weaknesses?.slice(0,3).join('; ') || '—'}`
  ];
  return summaryLines.join('\n');
}

// Webhook: Twilio inbound WhatsApp
app.post('/webhook', async (req, res) => {
  // Twilio sends x-www-form-urlencoded by default
  const message = (req.body.Body || '').trim();
  const from = (req.body.From || '').trim(); // e.g., whatsapp:+20123456789
  const messageSid = req.body.MessageSid;

  if (!from) {
    res.status(400).send('Missing From');
    return;
  }

  const { job, needJobCode } = getOrAskForJob({ message });

  if (needJobCode) {
    // Ask for job code
    await sendWhatsApp(from, 'Please reply with the job code (e.g., JOB-123).');
    return res.send('OK');
  }

  // Find or create session
  let sess = sessions.get(candidateKey(from, job.id));
  if (!sess) {
    // Create new session and send intro + first question
    sess = newSession({ from, jobId: job.id });
    await sendWhatsApp(from, job.introMessage || `Welcome to ${job.title} screening.`);
    const q = job.questions[sess.currentIndex];
    await sendWhatsApp(from, `Q${sess.currentIndex + 1}/${job.questions.length}: ${q.text}`);
    return res.send('OK');
  }

  // Idempotency: skip duplicate message sids
  if (messageSid && sess.processedMessageSids.has(messageSid)) {
    return res.send('OK');
  }
  if (messageSid) sess.processedMessageSids.add(messageSid);

  // Record answer to current question
  const idx = sess.currentIndex;
  if (idx < job.questions.length) {
    const question = job.questions[idx];
    sess.answers.push({ qid: question.id, question: question.text, answer: message, ts: new Date().toISOString() });
    sess.currentIndex += 1;
  }

  // If more questions remain
  if (sess.currentIndex < job.questions.length) {
    const nextQ = job.questions[sess.currentIndex];
    await sendWhatsApp(from, `Q${sess.currentIndex + 1}/${job.questions.length}: ${nextQ.text}`);
    return res.send('OK');
  }

  // Finished: analyze and send closing message + summary
  const summary = await finalizeAndNotify(job, sess);
  if (job.closingMessage) {
    await sendWhatsApp(from, job.closingMessage);
  }
  await sendWhatsApp(from, `Summary\n${summary}`);
  return res.send('OK');
});

// HR: create/update a job
// POST /jobs  { id, title, introMessage?, closingMessage?, hrWebhook?, questions: [{id,text,weight?}] }
app.post('/jobs', (req, res) => {
  const { id, title, introMessage, closingMessage, hrWebhook, questions } = req.body || {};
  if (!id || !title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'id, title, and questions[] are required' });
  }
  const norm = {
    id: String(id).toUpperCase(),
    title,
    introMessage: introMessage || '',
    closingMessage: closingMessage || '',
    hrWebhook: hrWebhook || '',
    questions: questions.map((q, i) => ({ id: q.id || `q${i+1}`, text: q.text, weight: q.weight || 1 }))
  };
  jobs.set(norm.id, norm);
  res.json({ ok: true, job: norm });
});

// HR: get a job
app.get('/jobs/:id', (req, res) => {
  const id = String(req.params.id).toUpperCase();
  if (!jobs.has(id)) return res.status(404).json({ error: 'Not found' });
  res.json(jobs.get(id));
});

// HR: get a session
app.get('/sessions/:sid', (req, res) => {
  const sid = req.params.sid;
  for (const sess of sessions.values()) {
    if (sess.id === sid) {
      return res.json({
        id: sess.id,
        jobId: sess.jobId,
        from: sess.from,
        startedAt: sess.startedAt,
        completedAt: sess.completedAt,
        answers: sess.answers,
        analysis: sess.analysis
      });
    }
  }
  res.status(404).json({ error: 'Not found' });
});

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
