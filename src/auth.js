const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { OAuth2Client } = require('google-auth-library');
const { getDb } = require('./db');
const { randomToken, sha256, serialize, asObjectId } = require('./utils');
const { apiError, sendAuthError } = require('./errors');

const ACCESS_TTL_SECONDS = Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 3600);
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.FAMFIN_APP_TOKEN;

function requireJwtSecret() {
  if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_ACCESS_SECRET must be configured with at least 32 characters.');
}

function signAccessToken(user, familyId) {
  requireJwtSecret();
  return jwt.sign(
    { email: user.primaryEmail, sid: familyId, typ: 'access' },
    JWT_SECRET,
    { algorithm: 'HS256', subject: user._id.toHexString(), issuer: 'famfin-data-api', audience: 'famfin-app', expiresIn: ACCESS_TTL_SECONDS }
  );
}

function verifyAccessToken(token, ignoreExpiration = false) {
  requireJwtSecret();
  return jwt.verify(token, JWT_SECRET, {
    algorithms: ['HS256'], issuer: 'famfin-data-api', audience: 'famfin-app', ignoreExpiration
  });
}

function sessionUserBody(user, prefs, accessToken, refreshToken, deviceId) {
  const decoded = jwt.decode(accessToken);
  return {
    user: {
      id: user._id.toHexString(),
      email: user.primaryEmail,
      displayName: user.preferredName || user.primaryEmail.split('@')[0],
      localeCode: prefs?.locale || 'en_IN',
      lastSignInAt: (user.lastLoginAt || user.createdAt || new Date()).toISOString()
    },
    accessToken,
    refreshToken,
    expiresAt: new Date(decoded.exp * 1000).toISOString(),
    deviceId
  };
}

async function issueSession(user, deviceId = null, familyId = null, session = null) {
  const db = getDb();
  const refreshToken = randomToken(48);
  const tokenHash = sha256(refreshToken);
  const fam = familyId || crypto.randomUUID();
  const dev = deviceId || `device-${Date.now()}-${crypto.randomInt(1000,9999)}`;
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000);
  const accessToken = signAccessToken(user, fam);
  await db.collection('auth_sessions').insertOne({
    userId: user._id,
    familyId: fam,
    tokenHash,
    deviceId: dev,
    createdAt: new Date(),
    expiresAt,
    revokedAt: null,
    replacedByHash: null
  }, session ? { session } : undefined);
  const prefs = await db.collection('user_preferences').findOne({ userId: user._id }, session ? { session } : undefined);
  return sessionUserBody(user, prefs, accessToken, refreshToken, dev);
}

async function authRateCheck(email, ip) {
  const db = getDb();
  const windowMs = 15 * 60 * 1000;
  const maxPerKey = 10;
  const keys = [`email:${email.toLowerCase()}`, `ip:${ip || 'unknown'}`];
  const now = new Date();
  for (const key of keys) {
    const row = await db.collection('auth_rate_limits').findOne({ key });
    if (row && row.expiresAt > now && row.count >= maxPerKey) {
      const err = new Error('rate_limited'); err.code = 'rate_limited'; throw err;
    }
  }
}

async function authRateFail(email, ip) {
  const db = getDb();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  for (const key of [`email:${email.toLowerCase()}`, `ip:${ip || 'unknown'}`]) {
    await db.collection('auth_rate_limits').updateOne(
      { key },
      [
        { $set: { key, count: { $add: [{ $ifNull: ['$count', 0] }, 1] }, expiresAt } }
      ],
      { upsert: true }
    );
  }
}

async function signUp(body, deviceId) {
  const db = getDb();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const displayName = String(body.displayName || '').trim();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw Object.assign(new Error(), { code: 'invalid_email' });
  if (!displayName) throw Object.assign(new Error(), { code: 'validation' });
  if (body.acceptedTerms !== true) throw Object.assign(new Error(), { code: 'validation' });
  if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 72) throw Object.assign(new Error(), { code: 'weak_password' });
  const existing = await db.collection('users').findOne({ primaryEmail: email });
  if (existing) throw Object.assign(new Error(), { code: 'email_taken' });
  const client = require('./db').getClient();
  const session = client.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      const user = {
        authUserId: crypto.randomUUID(), primaryEmail: email, emailVerified: false,
        preferredName: displayName, status: 'ACTIVE', createdAt: now, updatedAt: now, lastLoginAt: now
      };
      const inserted = await db.collection('users').insertOne(user, { session });
      user._id = inserted.insertedId;
      const passwordHash = await bcrypt.hash(password, 12);
      await db.collection('auth_credentials').insertOne({ userId: user._id, email, passwordHash, createdAt: now, passwordUpdatedAt: now }, { session });
      await db.collection('user_identities').insertOne({ userId: user._id, provider: 'EMAIL', providerSubject: email, providerEmail: email, createdAt: now, lastUsedAt: now }, { session });
      await db.collection('user_preferences').insertOne({
        userId: user._id, language: 'en', locale: body.locale || 'en_IN', aiLanguage: 'en', timezone: 'Asia/Kolkata',
        numberFormat: (body.locale || '').startsWith('en_IN') ? 'INDIAN' : 'INTERNATIONAL', theme: 'SYSTEM', updatedAt: now, version: 1
      }, { session });
      result = await issueSession(user, deviceId, null, session);
    });
  } finally { await session.endSession(); }
  return result;
}

async function signIn(body, deviceId, ip) {
  const db = getDb();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  await authRateCheck(email, ip);
  const user = await db.collection('users').findOne({ primaryEmail: email, status: { $ne: 'DELETED' } });
  const cred = user ? await db.collection('auth_credentials').findOne({ userId: user._id }) : null;
  const valid = !!(cred && await bcrypt.compare(password, cred.passwordHash));
  if (!valid) {
    await authRateFail(email, ip);
    throw Object.assign(new Error(), { code: 'invalid_credentials' });
  }
  const now = new Date();
  await db.collection('users').updateOne({ _id: user._id }, { $set: { lastLoginAt: now, updatedAt: now } });
  user.lastLoginAt = now;
  return issueSession(user, deviceId);
}

async function refreshSession(accessToken, refreshToken) {
  const db = getDb();
  let decoded;
  try { decoded = verifyAccessToken(accessToken, true); }
  catch { throw Object.assign(new Error(), { code: 'invalid_refresh' }); }
  const tokenHash = sha256(String(refreshToken || ''));
  const row = await db.collection('auth_sessions').findOne({ tokenHash });
  if (!row || row.expiresAt <= new Date()) throw Object.assign(new Error(), { code: 'invalid_refresh' });
  if (row.revokedAt) {
    if (row.replacedByHash) await db.collection('auth_sessions').updateMany({ familyId: row.familyId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: 'refresh_token_reuse' } });
    throw Object.assign(new Error(), { code: 'invalid_refresh' });
  }
  if (decoded.sub !== row.userId.toHexString()) throw Object.assign(new Error(), { code: 'invalid_refresh' });
  const user = await db.collection('users').findOne({ _id: row.userId, status: 'ACTIVE' });
  if (!user) throw Object.assign(new Error(), { code: 'invalid_refresh' });
  const newRefresh = randomToken(48);
  const newHash = sha256(newRefresh);
  const now = new Date();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000);
  const access = signAccessToken(user, row.familyId);
  await db.collection('auth_sessions').updateOne({ _id: row._id, revokedAt: null }, { $set: { revokedAt: now, replacedByHash: newHash } });
  await db.collection('auth_sessions').insertOne({ userId: user._id, familyId: row.familyId, tokenHash: newHash, deviceId: row.deviceId, createdAt: now, expiresAt, revokedAt: null, replacedByHash: null });
  const prefs = await db.collection('user_preferences').findOne({ userId: user._id });
  return sessionUserBody(user, prefs, access, newRefresh, row.deviceId);
}

async function signOut(accessToken) {
  try {
    const decoded = verifyAccessToken(accessToken, true);
    if (decoded.sid) await getDb().collection('auth_sessions').updateMany({ familyId: decoded.sid, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: 'sign_out' } });
  } catch {}
}

async function verifyOAuth(provider, idToken) {
  const p = String(provider || '').toLowerCase();
  if (p === 'google') {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw Object.assign(new Error(), { code: 'oauth_not_configured' });
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    return { provider: 'GOOGLE', subject: payload.sub, email: payload.email?.toLowerCase(), emailVerified: !!payload.email_verified, displayName: payload.name || null };
  }
  if (p === 'apple') {
    const audience = process.env.APPLE_CLIENT_ID;
    if (!audience) throw Object.assign(new Error(), { code: 'oauth_not_configured' });
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const jwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
    const { payload } = await jwtVerify(idToken, jwks, { issuer: 'https://appleid.apple.com', audience });
    return { provider: 'APPLE', subject: payload.sub, email: payload.email?.toLowerCase(), emailVerified: payload.email_verified === true || payload.email_verified === 'true', displayName: null };
  }
  throw Object.assign(new Error(), { code: 'invalid_oauth_provider' });
}

async function oauthSignIn(body, deviceId) {
  const db = getDb();
  let verified;
  try { verified = await verifyOAuth(body.provider, body.idToken); }
  catch (e) { if (e.code === 'oauth_not_configured') throw e; throw Object.assign(new Error(), { code: 'invalid_oauth' }); }
  let identity = await db.collection('user_identities').findOne({ provider: verified.provider, providerSubject: verified.subject });
  let user = identity ? await db.collection('users').findOne({ _id: identity.userId, status: { $ne: 'DELETED' } }) : null;
  if (!user) {
    if (!verified.email) throw Object.assign(new Error(), { code: 'invalid_oauth' });
    user = await db.collection('users').findOne({ primaryEmail: verified.email, status: { $ne: 'DELETED' } });
    const now = new Date();
    if (!user) {
      const doc = { authUserId: crypto.randomUUID(), primaryEmail: verified.email, emailVerified: verified.emailVerified, preferredName: verified.displayName || verified.email.split('@')[0], status: 'ACTIVE', createdAt: now, updatedAt: now, lastLoginAt: now };
      const r = await db.collection('users').insertOne(doc); doc._id = r.insertedId; user = doc;
      await db.collection('user_preferences').insertOne({ userId: user._id, language: 'en', locale: 'en_IN', aiLanguage: 'en', timezone: 'Asia/Kolkata', numberFormat: 'INDIAN', theme: 'SYSTEM', updatedAt: now, version: 1 });
    }
    await db.collection('user_identities').updateOne(
      { provider: verified.provider, providerSubject: verified.subject },
      { $setOnInsert: { userId: user._id, provider: verified.provider, providerSubject: verified.subject, providerEmail: verified.email, createdAt: now }, $set: { lastUsedAt: now } },
      { upsert: true }
    );
  }
  const now = new Date();
  await db.collection('users').updateOne({ _id: user._id }, { $set: { lastLoginAt: now, updatedAt: now } });
  user.lastLoginAt = now;
  return issueSession(user, deviceId);
}

async function deleteAccount(userId) {
  const db = getDb();
  const memberships = await db.collection('household_users').find({ userId, status: 'ACTIVE', role: 'HOUSEHOLD_ADMIN' }).toArray();
  for (const m of memberships) {
    const others = await db.collection('household_users').countDocuments({ householdId: m.householdId, status: 'ACTIVE', userId: { $ne: userId } });
    const otherAdmins = await db.collection('household_users').countDocuments({ householdId: m.householdId, status: 'ACTIVE', role: 'HOUSEHOLD_ADMIN', userId: { $ne: userId } });
    if (others > 0 && otherAdmins === 0) throw Object.assign(new Error(), { code: 'transfer_required' });
  }
  await db.collection('users').updateOne({ _id: userId }, { $set: { status: 'DELETED', updatedAt: new Date() } });
  await db.collection('auth_sessions').updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: 'account_deleted' } });
  await db.collection('auth_credentials').deleteMany({ userId });
}

function bearerFrom(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function authMiddleware(req, res, next) {
  const token = bearerFrom(req);
  if (!token) return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
  try {
    const decoded = verifyAccessToken(token, false);
    req.auth = { userId: asObjectId(decoded.sub, 'userId'), sessionFamilyId: decoded.sid, token };
    next();
  } catch {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
  }
}

module.exports = {
  signUp, signIn, refreshSession, signOut, oauthSignIn, deleteAccount,
  bearerFrom, authMiddleware, verifyAccessToken
};
