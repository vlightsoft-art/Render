# FamFin AI Gateway — Render Edition

Node.js middleware for the FamFin Flutter expense/finance app. Flutter calls this service; this service calls OpenAI and MongoDB Atlas. OpenAI and MongoDB credentials never belong in the Flutter app.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/ai/chat` | Required SSE streaming AI answers |
| POST | `/v1/ai/extract` | Document extraction |
| GET | `/v1/ai/quota` | Monthly server-side usage |
| GET | `/v1/ai/health` | App-facing AI reachability |
| POST | `/v1/ai/feedback` | Answer feedback |
| GET | `/healthz` | Render health checker only |

The server deliberately does **not** implement the deterministic Flutter finance engines. `safeToSpend`, `netWorth`, forecasts, loan calculations, goals, etc. remain client-side source-of-truth values supplied in `context`.

## 1. Before deploying

You need:

1. A GitHub repository containing this folder.
2. A Render account.
3. An OpenAI API key.
4. A MongoDB Atlas connection string.
5. A random FamFin application token.

Generate the app token on Windows/macOS/Linux with Node:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

If a MongoDB password/URI has ever been pasted into a chat, ticket, repository, or screenshot, rotate that database password before deployment.

## 2. MongoDB Atlas

Set `MONGODB_URI` to your Atlas connection string and `MONGODB_DB=familyfinanceapp`.

This gateway creates/uses these collections automatically:

- `famfin_ai_usage`
- `famfin_ai_feedback`
- `famfin_ai_requests` only when `STORE_CHAT_LOGS=true` (metadata only)

Chat text and financial context are not persisted by this service.

Ensure MongoDB Atlas Network Access allows connections from your Render service. For early testing you can temporarily allow broader access in Atlas, then tighten it using Render's current outbound IP information for your service.

## 3. Render Free deployment

### Option A — Render Dashboard

1. Push this folder to GitHub.
2. In Render: **New → Web Service**.
3. Connect the repository.
4. Runtime: **Node**.
5. Instance: **Free**.
6. Build Command: `npm install`
7. Start Command: `npm start`
8. Health Check Path: `/healthz`
9. Add the environment variables listed below.

Render assigns the public port using `PORT`; this server binds to `0.0.0.0` and reads that variable automatically.

### Option B — Blueprint

The included `render.yaml` can create the service. You still need to enter the three secret values in Render:

- `OPENAI_API_KEY`
- `MONGODB_URI`
- `FAMFIN_AI_APP_TOKEN`

## 4. Required Render environment variables

```text
OPENAI_API_KEY=...
MONGODB_URI=...
FAMFIN_AI_APP_TOKEN=...
MONGODB_DB=familyfinanceapp
OPENAI_MODEL=gpt-5.6-luna
OPENAI_EXTRACT_MODEL=gpt-5.6-luna
ENFORCE_QUOTA=true
DEFAULT_EDITION=plus
QUOTA_PLUS_AI=200
QUOTA_PLUS_SCANS=50
REGION=render
```

Do **not** add `PORT` in Render unless you specifically need to override Render's port.

The supplied FamFin contract gives a Plus quota example of 200 AI questions and 50 auto scans. Configure real Free/Family limits before switching households to those editions. An empty quota environment value means unlimited.

## 5. Local run

```bash
cp .env.example .env
npm install
npm start
```

Windows CMD:

```cmd
copy .env.example .env
npm install
npm start
```

Then test:

```bash
curl http://localhost:10000/healthz
```

## 6. Flutter configuration

After Render deploys, you receive a URL similar to:

```text
https://famfin-ai-gateway.onrender.com
```

Flutter configuration:

```text
FAMFIN_AI_GATEWAY=https://famfin-ai-gateway.onrender.com
FAMFIN_AI_APP_TOKEN=<same value configured in Render>
```

Example:

```bash
flutter run \
  --dart-define=FAMFIN_AI_GATEWAY=https://famfin-ai-gateway.onrender.com \
  --dart-define=FAMFIN_AI_APP_TOKEN=YOUR_APP_TOKEN
```

Only the gateway URL and middleware application token belong on the Flutter side. Never put `OPENAI_API_KEY` or `MONGODB_URI` in Flutter.

## 7. Free-instance note

Render Free web services spin down after inactivity. The next request wakes the service, so the first AI request after an idle period can be slower than normal. This is acceptable for testing, but it can conflict with the Flutter client's 90-second hard timeout if a cold start is unusually slow. Upgrade the Render instance when you need consistently low first-token latency.

## 8. API behavior

### Chat

`POST /v1/ai/chat` uses OpenAI's Responses API internally and converts its text deltas into the exact Flutter SSE shape:

```text
data: {"delta":"..."}

data: [DONE]
```

It sends `: ping` comments while waiting for the first model text delta. Upstream failures that occur before SSE starts return non-2xx JSON errors. A stream that fails after HTTP 200 has already begun is ended without `[DONE]`, allowing the Flutter fallback behavior rather than returning a fake 200 apology.

### Extraction

Images are sent as image input. Other Base64 documents are uploaded temporarily to OpenAI as `user_data`, referenced for extraction, and deleted afterward on a best-effort basis. Structured output is transformed into the contract's `fields` object. All field values are strings, so monetary values never become JSON floating-point numbers on this write path.

### Quota

Quota accounting is enforced only when Flutter sends `X-FamFin-Household`. If that header is absent, the server accepts the request as required by the current contract and cannot safely attribute usage to a household.

## Security note

`FAMFIN_AI_APP_TOKEN` is an application-level shared secret, not strong end-user authentication. A token embedded in a shipped mobile application can eventually be extracted. Before production billing, add real user/session authentication and use the household identity derived from your authenticated backend rather than trusting a caller-supplied household header alone.
