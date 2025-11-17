WhatsApp AI Assessment Platform

WhatsApp-based AI assessment flow for applicants with an HR dashboard to create roles, questions, and see submissions — powered by Twilio (WhatsApp), Node.js, MongoDB, and Groq.

Quick Start

- Requirements
  - Node.js 18+
  - Twilio account with WhatsApp Sandbox or WABA number
  - Groq API key (https://console.groq.com)
  - MongoDB (Atlas recommended) — set `MONGODB_URI`

- Setup
  1) Fill `.env` with at least: `TWILIO_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `GROQ_API_KEY`, and `MONGODB_URI`
  2) Install deps: `npm install`
  3) Start server: `npm start` (default port 3000)

- Admin Dashboard
  - Open http://localhost:3000/admin
  - Jobs List page: shows all jobs; click a job to open details
  - Job Details page has two tabs:
    - Job Details: edit job info, questions, candidate recipients, HR recipients; Save updates MongoDB
      - When creating a job, all candidate recipients receive the welcome message automatically
      - When adding new candidate numbers later, only new numbers receive the welcome message
    - Submissions: read-only list of applicant submissions with AI results

- Twilio Webhook
  - Expose server (e.g., `ngrok http 3000`)
  - In Twilio WhatsApp Sandbox, set WHEN A MESSAGE COMES IN to: `https://<your-host>/webhook`
  - The system proactively sends a welcome message to candidate recipients upon job creation (and to newly added numbers on update)
  - Applicants can also send: "ابدأ عزّام" (or "start") to begin; bot asks questions one by one

Data Model

- Job (MongoDB collection `jobs`)
  - jobId, title, description, responsibilities, requirements, skills, benefits
  - questions: [String]
  - candidateRecipients: [String] (candidates to receive welcome/start prompt)
  - hrRecipients: [String] (HR numbers that receive AI evaluation)
  - createdAt

- Submission (MongoDB collection `submissions`)
  - applicantPhone, jobId, answers: [{ question, answer }]
  - aiScore, aiStrengths, aiWeaknesses, aiDecision, aiSummary
  - createdAt

AI Evaluation
- Uses Groq’s OpenAI-compatible Chat Completions API: `https://api.groq.com/openai/v1/chat/completions`
- Default model: `llama-3.1-8b-instant` (override with env `GROQ_MODEL`)
- Prompt returns strict JSON with: score, strengths, weaknesses, decision, summary
- Candidates receive only a final thank-you message; AI evaluation goes to HR recipients

Railway Deployment (Backend)

- Create a Railway project and deploy this repo.
- Set environment variables (Service → Variables):
  - `TWILIO_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
  - `GROQ_API_KEY`, optional `GROQ_MODEL`
  - `MONGODB_URI` (use MongoDB Atlas connection string), optional `MONGODB_DB`
- After deploy, set Twilio webhook to `https://<railway-url>/webhook`

Notes
- Webhook deduplication handled via Twilio `MessageSid` stored on session documents.
- First answer per question is stored; subsequent messages do not overwrite.
- Admin UI is a lightweight React app served from `/admin` (no build step).
