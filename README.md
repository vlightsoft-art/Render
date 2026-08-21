# FamFin Unified API

One Node/Express service containing both existing FamFin backend surfaces:

- Data/Auth API: `/v1/auth/*` and `/api/*`
- AI Gateway: `/v1/ai/*`
- Render health: `/healthz`

The Data API contract remains unchanged. The AI Gateway contract remains unchanged.
They now share one Render host and the same `family_finance` MongoDB Atlas database.

## Local installation

```cmd
npm install
copy .env.example .env
```

Edit `.env` with real secrets, then:

```cmd
npm run verify-db
npm start
```

Health tests:

- `GET http://localhost:10000/healthz`
- `GET http://localhost:10000/api/health/database`
- `GET http://localhost:10000/v1/ai/health` (requires AI Bearer token if configured)

## Flutter configuration

Because this is one host, both values can be the same URL:

```text
FAMFIN_API_BASE=https://YOUR-SERVICE.onrender.com
FAMFIN_AI_GATEWAY=https://YOUR-SERVICE.onrender.com
```

Authentication remains different by contract:

- `/v1/auth/*` and `/api/*`: Flutter user access token + optional `x-app-token`
- `/v1/ai/*`: `Authorization: Bearer <FAMFIN_AI_APP_TOKEN>`

Do not replace one token with the other.

## Render

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Health check:

```text
/healthz
```

Add every required value from `.env.example` in Render Environment.
Render provides `PORT` automatically.

## Database administration scripts

Included for future verification/maintenance:

```cmd
npm run init-db
npm run verify-db
```

`init-db.js` is idempotent. Do not run it on a different database accidentally.

## Postman

Both collections are included under `postman/`:

- `FamFin_Data_API.postman_collection.json`
- `FamFin_AI_Gateway.postman_collection.json`

## Important

Never commit `.env`, OpenAI keys, MongoDB credentials, JWT secrets or app tokens.

## Family sharing API

Version 1.1 adds the exact Flutter family-sharing wire routes:

- `POST /api/households/:hid/invitations`
- `GET /api/households/:hid/invitations`
- `DELETE /api/households/:hid/invitations/:id`
- `POST /api/households/:hid/invitations/:id/role`
- `POST /api/invitations/redeem`

Invitation codes expire after seven days, are single-use, and redeem attempts are rate-limited. Existing `HOUSEHOLD_ADMIN` memberships are exposed/treated as `OWNER` for family-sharing authorization. Production invitation email is sent server-side through Resend; configure `RESEND_API_KEY` and `INVITE_FROM_EMAIL`.
