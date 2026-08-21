const express = require('express');
const multer = require('multer');
const { getDb } = require('./db');
const { apiError, sendApiError, sendAuthError } = require('./errors');
const { signUp, signIn, refreshSession, signOut, oauthSignIn, deleteAccount, bearerFrom, authMiddleware } = require('./auth');
const { listRecords, getOne, createRecord, updateRecord, deleteRecord, guardCollection } = require('./records');
const {
  responseEnvelope, createHousehold, getHousehold, updateHousehold, getMe,
  payBill, search, getPreferences, updatePreferences, getNotificationPreferences,
  updateNotificationPreferences, getEntitlements, verifySubscription, bulkTransactions,
  uploadDocument, getDocumentContent, requestExport, downloadExport, streamExportFile
} = require('./specials');
const { MAX_UPLOAD_BYTES } = require('./constants');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function appTokenGuard(req, res, next) {
  const expected = process.env.FAMFIN_APP_TOKEN;
  if (!expected) return next();
  const supplied = req.get('x-app-token');
  if (supplied !== expected) {
    if (req.path.startsWith('/v1/auth/')) return sendAuthError(res, 401, 'invalid_app_token', 'The app authorization token is invalid.');
    return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
  }
  next();
}

function authErrorHandler(res, e) {
  if (e && e.code === 11000) return sendAuthError(res, 409, 'email_taken', 'That email is already registered.');
  switch (e.code) {
    case 'email_taken': return sendAuthError(res, 409, 'email_taken', 'That email is already registered.');
    case 'weak_password': return sendAuthError(res, 400, 'weak_password', 'Use a stronger password with at least 10 characters.');
    case 'rate_limited': return sendAuthError(res, 429, 'rate_limited', 'Too many attempts. Please try again later.');
    case 'invalid_credentials': return sendAuthError(res, 401, 'invalid_credentials', 'The email or password is incorrect.');
    case 'invalid_refresh': return sendAuthError(res, 401, 'invalid_refresh', 'Your session has expired. Sign in again.');
    case 'invalid_oauth': return sendAuthError(res, 401, 'invalid_oauth_token', 'The sign-in token could not be verified.');
    case 'invalid_oauth_provider': return sendAuthError(res, 400, 'invalid_oauth_provider', 'Choose Google or Apple sign-in.');
    case 'oauth_not_configured': return sendAuthError(res, 503, 'oauth_not_configured', 'That sign-in provider is temporarily unavailable.');
    case 'transfer_required': return sendAuthError(res, 409, 'transfer_required', 'Transfer household admin before deleting your account.');
    case 'invalid_email': return sendAuthError(res, 400, 'invalid_email', 'Enter a valid email address.');
    case 'validation': return sendAuthError(res, 400, 'validation_error', 'Complete all required sign-up information.');
    default:
      console.error(e);
      return sendAuthError(res, 500, 'internal_error', 'Unable to sign in right now. Please retry.');
  }
}

// Unauthenticated database health, deliberately content-light.
router.get('/api/health/database', asyncRoute(async (req, res) => {
  try { await getDb().command({ ping: 1 }); return res.status(200).json({ database: 'connected' }); }
  catch { return res.status(503).json({ database: 'unavailable' }); }
}));

// Signed export file URL; the JWT in the query is the authorization.
router.get('/api/exports/files/:id', asyncRoute(async (req, res) => {
  await streamExportFile(req.params.id, req.query.token, res);
}));

router.use(appTokenGuard);

// ---------------------------- Identity ------------------------------------
router.post('/v1/auth/sign-up', asyncRoute(async (req, res) => {
  try { return res.status(201).json(await signUp(req.body, req.get('x-device-id'))); }
  catch (e) { return authErrorHandler(res, e); }
}));

router.post('/v1/auth/sign-in', asyncRoute(async (req, res) => {
  try { return res.status(200).json(await signIn(req.body, req.get('x-device-id'), req.ip)); }
  catch (e) { return authErrorHandler(res, e); }
}));

router.post('/v1/auth/oauth', asyncRoute(async (req, res) => {
  try { return res.status(200).json(await oauthSignIn(req.body, req.get('x-device-id'))); }
  catch (e) { return authErrorHandler(res, e); }
}));

router.post('/v1/auth/refresh', asyncRoute(async (req, res) => {
  try {
    const token = bearerFrom(req);
    if (!token) return sendAuthError(res, 401, 'invalid_refresh', 'Your session has expired. Sign in again.');
    return res.status(200).json(await refreshSession(token, req.body?.refreshToken));
  } catch (e) { return authErrorHandler(res, e); }
}));

router.post('/v1/auth/reset', asyncRoute(async (req, res) => {
  // Deliberately always 200. The contract has no reset-confirm endpoint, so
  // email delivery belongs to the chosen identity provider/service.
  return res.status(200).end();
}));

router.post('/v1/auth/sign-out', asyncRoute(async (req, res) => {
  await signOut(bearerFrom(req));
  return res.status(200).end();
}));

router.delete('/v1/auth/account', asyncRoute(async (req, res) => {
  const token = bearerFrom(req);
  if (!token) return sendAuthError(res, 401, 'invalid_credentials', 'Sign in to continue.');
  try {
    const { verifyAccessToken } = require('./auth');
    const decoded = verifyAccessToken(token, false);
    await deleteAccount(new (require('mongodb').ObjectId)(decoded.sub));
    return res.status(200).end();
  } catch (e) {
    if (e && (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError')) return sendAuthError(res, 401, 'invalid_credentials', 'Sign in to continue.');
    return authErrorHandler(res, e);
  }
}));

// Everything below requires a valid access token.
router.use('/api', authMiddleware);

// -------------------------- Blocking gaps ---------------------------------
router.post('/api/households', asyncRoute(async (req, res) => {
  const data = await createHousehold(req.auth.userId, req.body, req);
  res.setHeader('etag', `"${data.version}"`);
  return res.status(201).json(responseEnvelope(data));
}));

router.get('/api/me', asyncRoute(async (req, res) => res.json(responseEnvelope(await getMe(req.auth.userId)))));

router.get('/api/me/preferences', asyncRoute(async (req, res) => {
  const data = await getPreferences(req.auth.userId); if (data.version) res.setHeader('etag', `"${data.version}"`); res.json(responseEnvelope(data));
}));
router.put('/api/me/preferences', asyncRoute(async (req, res) => {
  const data = await updatePreferences(req.auth.userId, req.body, req); res.setHeader('etag', `"${data.version}"`); res.json(responseEnvelope(data));
}));
router.get('/api/me/notification-preferences', asyncRoute(async (req, res) => {
  const data = await getNotificationPreferences(req.auth.userId); if (data.version) res.setHeader('etag', `"${data.version}"`); res.json(responseEnvelope(data));
}));
router.put('/api/me/notification-preferences', asyncRoute(async (req, res) => {
  const data = await updateNotificationPreferences(req.auth.userId, req.body, req); res.setHeader('etag', `"${data.version}"`); res.json(responseEnvelope(data));
}));

router.get('/api/households/:householdId/entitlements', asyncRoute(async (req, res) => res.json(responseEnvelope(await getEntitlements(req.auth.userId, req.params.householdId)))));
router.post('/api/households/:householdId/subscriptions/verify', asyncRoute(async (req, res) => res.json(responseEnvelope(await verifySubscription(req.auth.userId, req.params.householdId, req.body)))));

router.post('/api/households/:householdId/transactions/bulk', asyncRoute(async (req, res) => {
  const data = await bulkTransactions(req.auth.userId, req.params.householdId, req.body, req); return res.status(201).json(responseEnvelope(data));
}));

router.post('/api/households/:householdId/documents/upload', upload.single('file'), asyncRoute(async (req, res) => {
  const data = await uploadDocument(req.auth.userId, req.params.householdId, req.file, req.body, req); return res.status(201).json(responseEnvelope(data));
}));
router.get('/api/households/:householdId/documents/:id/content', asyncRoute(async (req, res) => {
  await getDocumentContent(req.auth.userId, req.params.householdId, req.params.id, res);
}));

// --------------------------- Special data ---------------------------------
router.post('/api/households/:householdId/bill-instances/:id/pay', asyncRoute(async (req, res) => res.json(responseEnvelope(await payBill(req.auth.userId, req.params.householdId, req.params.id, req.body, req)))));
router.get('/api/households/:householdId/search', asyncRoute(async (req, res) => res.json(responseEnvelope(await search(req.auth.userId, req.params.householdId, req.query)))));
router.post('/api/households/:householdId/exports', asyncRoute(async (req, res) => {
  const data = await requestExport(req.auth.userId, req.params.householdId, req.body, req); return res.status(202).json(responseEnvelope(data));
}));
router.get('/api/households/:householdId/exports/:id/download', asyncRoute(async (req, res) => res.json(responseEnvelope(await downloadExport(req.auth.userId, req.params.householdId, req.params.id)))));

// --------------------------- Household ------------------------------------
router.get('/api/households/:householdId', asyncRoute(async (req, res) => {
  const data = await getHousehold(req.auth.userId, req.params.householdId); if (data.version) res.setHeader('etag', `"${data.version}"`); res.json(responseEnvelope(data));
}));
router.put('/api/households/:householdId', asyncRoute(async (req, res) => {
  const data = await updateHousehold(req.auth.userId, req.params.householdId, req.body, req); res.setHeader('etag', `"${data.version}"`); res.json(responseEnvelope(data));
}));

// -------------------------- Generic record API ----------------------------
router.get('/api/households/:householdId/:collection', asyncRoute(async (req, res) => {
  guardCollection(req.params.collection);
  const result = await listRecords(req.auth.userId, req.params.householdId, req.params.collection, req.query);
  return res.json(responseEnvelope(result.data, result.meta));
}));
router.get('/api/households/:householdId/:collection/:id', asyncRoute(async (req, res) => {
  guardCollection(req.params.collection);
  const data = await getOne(req.auth.userId, req.params.householdId, req.params.collection, req.params.id);
  if (data.version) res.setHeader('etag', `"${data.version}"`);
  return res.json(responseEnvelope(data));
}));
router.post('/api/households/:householdId/:collection', asyncRoute(async (req, res) => {
  guardCollection(req.params.collection);
  const result = await createRecord(req.auth.userId, req.params.householdId, req.params.collection, req.body, req);
  if (result.data.version) res.setHeader('etag', `"${result.data.version}"`);
  return res.status(result.status).json(responseEnvelope(result.data));
}));
router.put('/api/households/:householdId/:collection/:id', asyncRoute(async (req, res) => {
  guardCollection(req.params.collection);
  const data = await updateRecord(req.auth.userId, req.params.householdId, req.params.collection, req.params.id, req.body, req);
  res.setHeader('etag', `"${data.version}"`);
  return res.json(responseEnvelope(data));
}));
router.delete('/api/households/:householdId/:collection/:id', asyncRoute(async (req, res) => {
  guardCollection(req.params.collection);
  return res.json(responseEnvelope(await deleteRecord(req.auth.userId, req.params.householdId, req.params.collection, req.params.id, req)));
}));

// Route miss beneath API uses the standard envelope.
router.use('/api', (req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'That endpoint does not exist.' } }));

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'The document must be 12 MB or smaller.', field: 'file' } });
  }
  return sendApiError(res, err);
});

module.exports = router;
