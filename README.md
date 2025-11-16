WhatsApp AI Screening Bot

Backend for a Twilio WhatsApp chatbot that interviews candidates using HR-provided questions, then generates an AI analysis and score out of 100 for each candidate.

Quick Start

- Requirements
  - Node.js 18+
  - Twilio account with WhatsApp Sandbox or WABA number
  - Groq API key (get one at https://console.groq.com)

- Setup
  1) Create or edit a local .env and fill TWILIO_SID, TWILIO_AUTH_TOKEN, GROQ_API_KEY, and optionally TWILIO_WHATSAPP_FROM
  2) Install deps: npm install
  3) Start server: npm start (default port 3000)

- Expose webhook
  - Use a tunnel (e.g., ngrok) to expose the server: ngrok http 3000
  - In Twilio Console (WhatsApp Sandbox), set WHEN A MESSAGE COMES IN to: https://<your-ngrok-host>/webhook

- Create a job
  POST http://localhost:3000/jobs
  Content-Type: application/json
  {
    "id": "JOB-X",
    "title": "Account Manager",
    "introMessage": "Thanks for applying to Account Manager. I will ask a few questions.",
    "closingMessage": "Thanks! We've recorded your responses.",
    "hrWebhook": "https://example.com/hr-hook", // optional
    "questions": [
      { "id": "q1", "text": "Briefly introduce yourself." },
      { "id": "q2", "text": "Tell us about your sales experience." },
      { "id": "q3", "text": "What are your salary expectations?" }
    ]
  }

- Candidate flow
  - If there is only one active job, the bot starts immediately upon first message.
  - If there are multiple jobs, candidates must send the job code (e.g., "JOB-X" or "APPLY JOB-X").
  - You can share a deep link: https://wa.me/<E164_NUMBER_NO_PLUS>?text=APPLY%20JOB-X

- Fetch a session
  GET /sessions/:sid returns transcript + AI analysis JSON.

Notes

- Data is stored in memory for simplicity. Replace with Redis or a database for production.
- The webhook is idempotent on MessageSid to prevent duplicate processing on Twilio retries.
- Uses Groq’s OpenAI-compatible chat completions API at https://api.groq.com/openai/v1/chat/completions. Default model: `llama-3.1-8b-instant` (override with `GROQ_MODEL`).
- You can add rubric/weights per question and tune prompts in `server.js` (function `analyzeCandidate`).
