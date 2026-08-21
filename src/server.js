require('dotenv').config();
const express = require('express');
const dataRouter = require('./routes');
const { connectDatabase, ensureRuntimeCollections, closeDatabase } = require('./db');
const { startExportWorker } = require('./specials');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// One CORS policy for BOTH contracts. OPTIONS must finish before any auth.
app.use((req, res, next) => {
  const allowed = (process.env.CORS_ORIGINS || process.env.CORS_ALLOW_ORIGIN || '*')
    .split(',').map(x => x.trim()).filter(Boolean);
  const origin = req.get('origin');
  const allowOrigin = allowed.includes('*') ? '*' : (origin && allowed.includes(origin) ? origin : allowed[0]);
  if (allowOrigin) res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization, content-type, accept, x-app-token, x-correlation-id, if-match, x-step-up, x-device-id, x-famfin-client, x-famfin-household'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'etag');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// AI extraction can carry base64 documents; 12 MB matches the contract/client cap.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '12mb' }));

// Render/simple health endpoint.
app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

// Unified service information. No secrets/hostnames/counts.
app.get('/', (_req, res) => {
  res.status(200).json({
    service: 'FamFin Unified API',
    status: 'ok',
    surfaces: ['/v1/auth/*', '/api/*', '/v1/ai/*']
  });
});

const port = Number(process.env.PORT || 10000);

async function start() {
  await connectDatabase();
  await ensureRuntimeCollections();

  // Keep the proven AI gateway implementation as an isolated router while
  // sharing this process, host, CORS layer and MongoDB database configuration.
  const { default: aiRouter } = await import('./ai-gateway.mjs');
  app.use(aiRouter);
  app.use(dataRouter);

  startExportWorker();

  app.listen(port, '0.0.0.0', () => {
    console.log(`FamFin Unified API listening on 0.0.0.0:${port}`);
    console.log(`Database: ${process.env.MONGODB_DB || 'family_finance'}`);
    console.log('Data/Auth: /api/* and /v1/auth/*');
    console.log('AI: /v1/ai/*');
  });
}

start().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => { await closeDatabase(); process.exit(0); });
process.on('SIGINT', async () => { await closeDatabase(); process.exit(0); });
