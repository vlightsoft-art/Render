const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const { ObjectId, Decimal128 } = require('mongodb');
const { getDb, getClient, documentBucket, exportBucket } = require('./db');
const { apiError } = require('./errors');
const { requirePermission, getMembership, permissionsForMembership, visibilityFilter } = require('./permissions');
const { GENERIC_COLLECTIONS, COLLECTION_CONFIG, ALLOWED_UPLOAD_MIME, MAX_UPLOAD_BYTES } = require('./constants');
const { asObjectId, serialize, parseMoney, parseDate, sanitizeRecordBody, correlationId, randomToken } = require('./utils');
const { upsertSearchDocument, emitDomainEvent, enqueueSearchJob, parseVersion } = require('./records');

function responseEnvelope(data, meta) {
  const out = { success: true, data };
  if (meta) out.meta = meta;
  return out;
}

async function createHousehold(userId, body, req) {
  const db = getDb();
  const client = getClient();
  const name = String(body.name || '').trim();
  const baseCurrency = String(body.baseCurrency || '').trim().toUpperCase();
  const allowedTypes = ['INDIVIDUAL','COUPLE','FAMILY','JOINT_FAMILY','SINGLE_PARENT','OTHER'];
  if (!name) throw apiError(400, 'VALIDATION_ERROR', 'Enter a household name.', 'name');
  if (!/^[A-Z]{3}$/.test(baseCurrency)) throw apiError(400, 'VALIDATION_ERROR', 'Enter a valid base currency.', 'baseCurrency');
  if (body.type && !allowedTypes.includes(body.type)) throw apiError(400, 'VALIDATION_ERROR', 'Choose a valid household type.', 'type');
  const startDay = body.financialMonthStartDay == null ? 1 : Number(body.financialMonthStartDay);
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 28) throw apiError(400, 'VALIDATION_ERROR', 'Choose a financial month start day from 1 to 28.', 'financialMonthStartDay');
  const now = new Date();
  const session = client.startSession();
  let household;
  try {
    await session.withTransaction(async () => {
      const h = {
        name, type: body.type || 'FAMILY', country: body.country || null, baseCurrency,
        timezone: body.timezone || 'Asia/Kolkata', financialMonthStartDay: startDay,
        financialYearType: body.financialYearType || 'CALENDAR', setupStatus: 'ACTIVE',
        createdBy: userId, version: 1, createdAt: now, updatedAt: now
      };
      const hr = await db.collection('households').insertOne(h, { session });
      h._id = hr.insertedId;
      household = h;
      const user = await db.collection('users').findOne({ _id: userId }, { session });
      const member = {
        householdId: h._id, linkedUserId: userId, name: user?.preferredName || user?.primaryEmail || 'Me', relationship: 'SELF',
        financialRole: 'EARNER', status: 'ACTIVE', version: 1, isDeleted: false, visibility: 'HOUSEHOLD', source: 'SYSTEM',
        createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId, currency: baseCurrency
      };
      const mr = await db.collection('family_members').insertOne(member, { session });
      member._id = mr.insertedId;
      await db.collection('household_users').insertOne({
        householdId: h._id, userId, familyMemberId: member._id, role: 'HOUSEHOLD_ADMIN', status: 'ACTIVE', joinedAt: now, updatedAt: now
      }, { session });

      // Contract asks for a household copy of defaults. Clone every global system
      // category, preserving parent relationships when children exist.
      const systemCats = await db.collection('expense_categories').find({ householdId: null, systemCategory: true }).toArray();
      const map = new Map();
      for (const c of systemCats) map.set(c._id.toHexString(), new ObjectId());
      if (systemCats.length) {
        const copies = systemCats.map(c => ({
          _id: map.get(c._id.toHexString()), householdId: h._id, name: c.name,
          parentCategoryId: c.parentCategoryId ? map.get(c.parentCategoryId.toHexString()) || null : null,
          icon: c.icon || null, colorHex: c.colorHex || null, systemCategory: false,
          categoryGroup: c.categoryGroup, isActive: c.isActive !== false, displayOrder: c.displayOrder || 0,
          version: 1, isDeleted: false, visibility: 'HOUSEHOLD', source: 'SYSTEM',
          createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId, currency: baseCurrency
        }));
        await db.collection('expense_categories').insertMany(copies, { session });
      }
      await db.collection('domain_events').insertOne({
        eventId: crypto.randomUUID(), eventType: 'HOUSEHOLD_CREATED', householdId: h._id,
        payload: { entityId: h._id, correlationId: correlationId(req) }, occurredAt: now,
        processingStatus: 'PENDING', attempts: 0
      }, { session });
    });
  } finally { await session.endSession(); }
  return serialize(household);
}

async function getHousehold(userId, householdId) {
  await getMembership(userId, householdId);
  const doc = await getDb().collection('households').findOne({ _id: asObjectId(householdId) });
  if (!doc) throw apiError(404, 'NOT_FOUND', 'That household no longer exists.');
  return serialize(doc);
}

async function updateHousehold(userId, householdId, body, req) {
  const db = getDb();
  const membership = await getMembership(userId, householdId);
  if (membership.role !== 'HOUSEHOLD_ADMIN') throw apiError(403, 'FORBIDDEN', 'Only a household admin can change household settings.');
  const version = parseVersion(req);
  const hid = membership.householdId;
  const current = await db.collection('households').findOne({ _id: hid });
  if (!current) throw apiError(404, 'NOT_FOUND', 'That household no longer exists.');
  if (current.version !== version) throw apiError(409, 'VERSION_CONFLICT', 'This information was changed on another device. Refresh and review the latest version.', undefined, { remote: serialize(current) });
  const allowed = ['name','type','country','baseCurrency','timezone','financialMonthStartDay','financialYearType','setupStatus'];
  const clean = {};
  for (const k of allowed) if (k in body) clean[k] = body[k];
  if (clean.financialMonthStartDay != null) {
    const n = Number(clean.financialMonthStartDay);
    if (!Number.isInteger(n) || n < 1 || n > 28) throw apiError(400, 'VALIDATION_ERROR', 'Choose a financial month start day from 1 to 28.', 'financialMonthStartDay');
    clean.financialMonthStartDay = n;
  }
  if (clean.baseCurrency && clean.baseCurrency !== current.baseCurrency) {
    const count = await db.collection('transactions').countDocuments({ householdId: hid, isDeleted: { $ne: true } }, { limit: 1 });
    if (count > 0) throw apiError(400, 'VALIDATION_ERROR', 'Base currency cannot be changed after transactions have been recorded.', 'baseCurrency');
  }
  const updated = await db.collection('households').findOneAndUpdate(
    { _id: hid, version }, { $set: { ...clean, updatedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: 'after' }
  );
  return serialize(updated);
}

async function getMe(userId) {
  const db = getDb();
  const user = await db.collection('users').findOne({ _id: userId });
  if (!user) throw apiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  const memberships = await db.collection('household_users').find({ userId, status: 'ACTIVE' }).toArray();
  const households = [];
  const perms = new Set();
  for (const m of memberships) {
    const h = await db.collection('households').findOne({ _id: m.householdId });
    if (!h) continue;
    households.push({
      householdId: h._id, name: h.name, role: m.role, familyMemberId: m.familyMemberId,
      baseCurrency: h.baseCurrency, status: m.status
    });
    for (const p of await permissionsForMembership(m)) perms.add(p);
  }
  return serialize({
    user: { _id: user._id, primaryEmail: user.primaryEmail, preferredName: user.preferredName, status: user.status },
    households, permissions: [...perms].sort()
  });
}

async function payBill(userId, householdId, id, body, req) {
  const { membership } = await requirePermission(userId, householdId, 'bill.update');
  const db = getDb(); const client = getClient(); const session = client.startSession();
  const hid = membership.householdId; const oid = asObjectId(id);
  const amount = parseMoney(body.amount, 'amount');
  if (!amount) throw apiError(400, 'VALIDATION_ERROR', 'Enter an amount greater than zero.', 'amount');
  const currency = String(body.currency || '').toUpperCase();
  const household = await db.collection('households').findOne({ _id: hid });
  if (currency && household && currency !== household.baseCurrency) throw apiError(400, 'VALIDATION_ERROR', 'Bill payment currency must match the household base currency.', 'currency');
  let result;
  try {
    await session.withTransaction(async () => {
      const bill = await db.collection('bill_instances').findOne({ _id: oid, householdId: hid, isDeleted: { $ne: true } }, { session });
      if (!bill) throw apiError(404, 'NOT_FOUND', 'That record no longer exists.');
      if (bill.linkedExpenseId) {
        result = { expenseId: bill.linkedExpenseId.toHexString(), alreadyPaid: true };
        return;
      }
      const now = new Date();
      const paidCal = body.paidDate || now.toISOString().slice(0,10);
      const expenseDate = new Date(`${paidCal}T00:00:00.000Z`);
      const expense = {
        householdId: hid, paidByMemberId: membership.familyMemberId || null, accountId: asObjectId(body.accountId, 'accountId'),
        amount, baseAmount: amount, baseCurrency: household?.baseCurrency || currency, fxRate: Decimal128.fromString('1'),
        expenseDate, merchant: body.merchant || null, categoryId: asObjectId(body.categoryId, 'categoryId'),
        ownership: 'HOUSEHOLD', nature: 'VARIABLE', costType: 'ESSENTIAL', planningType: 'PLANNED', spendingType: 'NEED',
        paymentMethod: 'AUTO_DEBIT', reimbursementStatus: 'NOT_APPLICABLE', source: 'SYSTEM', visibility: 'HOUSEHOLD',
        currency: household?.baseCurrency || currency, status: 'ACTIVE', version: 1, isDeleted: false,
        createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId
      };
      const er = await db.collection('expenses').insertOne(expense, { session }); expense._id = er.insertedId;
      const txn = {
        householdId: hid, accountId: expense.accountId, transactionType: 'EXPENSE', amount,
        transactionDate: expenseDate, description: `Bill payment: ${body.merchant || 'Bill'}`, merchant: body.merchant || null,
        linkedEntityType: 'expenses', linkedEntityId: expense._id, currency: expense.currency,
        status: 'ACTIVE', version: 1, isDeleted: false, visibility: 'HOUSEHOLD', source: 'SYSTEM',
        createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId
      };
      const tr = await db.collection('transactions').insertOne(txn, { session }); txn._id = tr.insertedId;
      await db.collection('bill_instances').updateOne(
        { _id: oid, householdId: hid, $or: [{ linkedExpenseId: null }, { linkedExpenseId: { $exists: false } }] },
        { $set: { status: 'PAID', actualAmount: amount, paidDate: paidCal, linkedExpenseId: expense._id, updatedAt: now, updatedBy: userId }, $inc: { version: 1 } },
        { session }
      );
      await upsertSearchDocument(db, session, 'expenses', expense);
      await upsertSearchDocument(db, session, 'transactions', txn);
      await emitDomainEvent(db, session, 'bill_instances', 'PAID', hid, oid, correlationId(req), { expenseId: expense._id, transactionId: txn._id });
      await enqueueSearchJob(db, session, hid, 'expenses', expense._id);
      result = { expenseId: expense._id.toHexString(), alreadyPaid: false };
    });
  } finally { await session.endSession(); }
  return result;
}

async function search(userId, householdId, query) {
  const membership = await getMembership(userId, householdId);
  const q = String(query.q || '').trim();
  if (q.length < 2) return [];
  const limit = Math.min(Math.max(Number(query.limit || 40) || 40, 1), 100);
  const modules = String(query.modules || '').split(',').map(x => x.trim()).filter(Boolean).filter(x => GENERIC_COLLECTIONS.includes(x));
  const filter = { householdId: membership.householdId, $text: { $search: q } };
  if (modules.length) filter.entityType = { $in: modules };
  const candidates = await getDb().collection('search_documents').find(filter, { projection: { score: { $meta: 'textScore' } } }).sort({ score: { $meta: 'textScore' } }).limit(limit * 3).toArray();
  const out = [];
  for (const s of candidates) {
    if (out.length >= limit) break;
    if (!GENERIC_COLLECTIONS.includes(s.entityType)) continue;
    const vis = await visibilityFilter(membership, s.entityType);
    const source = await getDb().collection(s.entityType).findOne({
      $and: [{ _id: s.entityId }, s.entityType === 'expense_categories' ? { $or: [{ householdId: membership.householdId }, { householdId: null }] } : { householdId: membership.householdId }, { isDeleted: { $ne: true } }, vis]
    });
    if (!source) continue;
    out.push(serialize({ _id: s._id, entityType: s.entityType, entityId: s.entityId, title: s.title, amount: s.amount, date: s.date, score: s.score }));
  }
  return out;
}

async function getPreferences(userId) {
  const row = await getDb().collection('user_preferences').findOne({ userId });
  if (!row) throw apiError(404, 'NOT_FOUND', 'Preferences are not available yet.');
  return serialize(row);
}

async function updatePreferences(userId, body, req) {
  const db = getDb(); const current = await db.collection('user_preferences').findOne({ userId });
  if (!current) throw apiError(404, 'NOT_FOUND', 'Preferences are not available yet.');
  const version = parseVersion(req); const currentVersion = current.version || 1;
  if (currentVersion !== version) throw apiError(409, 'VERSION_CONFLICT', 'This information was changed on another device. Refresh and review the latest version.', undefined, { remote: serialize({ ...current, version: currentVersion }) });
  const forbidden = ['mpin','biometric','autoLock','analyticsOptIn'];
  for (const f of forbidden) if (f in body) throw apiError(400, 'VALIDATION_ERROR', 'That setting belongs to this device and cannot be synced.', f);
  const allowed = ['language','locale','aiLanguage','timezone','dateFormat','numberFormat','firstDayOfWeek','theme','accent','displayDensity','dashboardLayout'];
  const set = {}; for (const k of allowed) if (k in body) set[k] = body[k];
  const updated = await db.collection('user_preferences').findOneAndUpdate({ userId }, { $set: { ...set, updatedAt: new Date(), version: currentVersion + 1 } }, { returnDocument: 'after' });
  return serialize(updated);
}

async function getNotificationPreferences(userId) {
  const db = getDb(); let row = await db.collection('notification_preferences').findOne({ userId });
  if (!row) {
    row = { userId, channelEmail: true, channelPush: true, channelInApp: true, billReminders: true, budgetAlerts: true, auditFindings: true, goalMilestones: true, reminderLeadDays: 3, version: 1 };
    const r = await db.collection('notification_preferences').insertOne(row); row._id = r.insertedId;
  }
  return serialize(row);
}

async function updateNotificationPreferences(userId, body, req) {
  const db = getDb(); let current = await db.collection('notification_preferences').findOne({ userId });
  if (!current) { await getNotificationPreferences(userId); current = await db.collection('notification_preferences').findOne({ userId }); }
  const version = parseVersion(req); const cv = current.version || 1;
  if (cv !== version) throw apiError(409, 'VERSION_CONFLICT', 'This information was changed on another device. Refresh and review the latest version.', undefined, { remote: serialize({ ...current, version: cv }) });
  const allowed = ['channelEmail','channelPush','channelInApp','billReminders','budgetAlerts','auditFindings','goalMilestones','quietHoursStart','quietHoursEnd','reminderLeadDays'];
  const set = {}; for (const k of allowed) if (k in body) set[k] = body[k];
  const updated = await db.collection('notification_preferences').findOneAndUpdate({ userId }, { $set: { ...set, version: cv + 1 } }, { returnDocument: 'after' });
  return serialize(updated);
}

async function getEntitlements(userId, householdId) {
  const membership = await getMembership(userId, householdId); const db = getDb();
  const subscription = await db.collection('subscriptions').find({ householdId: membership.householdId, isDeleted: { $ne: true } }).sort({ currentPeriodEnd: -1 }).limit(1).next();
  const features = await db.collection('entitlements').find({ householdId: membership.householdId, isDeleted: { $ne: true }, $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] }).toArray();
  return serialize({ plan: subscription?.plan || 'FREE', status: subscription?.status || 'ACTIVE', currentPeriodEnd: subscription?.currentPeriodEnd || null, features: features.map(f => ({ featureCode: f.featureCode, isEnabled: !!f.isEnabled, limitValue: f.limitValue ?? null })) });
}

async function verifySubscription(userId, householdId, body) {
  await getMembership(userId, householdId);
  const verifierUrl = process.env.SUBSCRIPTION_VERIFIER_URL;
  if (!verifierUrl) throw apiError(500, 'INTERNAL_ERROR', 'Unable to save right now. Your information was not lost. Please retry.');
  const response = await fetch(verifierUrl, {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${process.env.SUBSCRIPTION_VERIFIER_TOKEN || ''}` },
    body: JSON.stringify({ householdId, platform: body.platform, purchaseToken: body.purchaseToken })
  });
  if (!response.ok) throw apiError(400, 'VALIDATION_ERROR', 'The store purchase could not be verified.', 'purchaseToken');
  const verified = await response.json();
  const db = getDb(); const hid = asObjectId(householdId); const now = new Date();
  await db.collection('subscriptions').updateOne({ householdId: hid, platform: body.platform }, { $set: {
    householdId: hid, plan: verified.plan, status: verified.status, platform: body.platform,
    storeTransactionId: verified.storeTransactionId || null, originalPurchaseDate: verified.originalPurchaseDate ? new Date(verified.originalPurchaseDate) : null,
    currentPeriodEnd: verified.currentPeriodEnd ? new Date(verified.currentPeriodEnd) : null, autoRenew: !!verified.autoRenew,
    verifiedAt: now, version: 1, isDeleted: false, createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId, visibility: 'ADMIN_ONLY', source: 'SYSTEM'
  } }, { upsert: true });
  for (const f of verified.features || []) {
    await db.collection('entitlements').updateOne({ householdId: hid, featureCode: f.featureCode }, { $set: {
      householdId: hid, featureCode: f.featureCode, isEnabled: !!f.isEnabled, limitValue: f.limitValue ?? null,
      source: 'PLAN', expiresAt: f.expiresAt ? new Date(f.expiresAt) : null, version: 1, isDeleted: false,
      createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId, visibility: 'ADMIN_ONLY'
    } }, { upsert: true });
  }
  return getEntitlements(userId, householdId);
}

async function bulkTransactions(userId, householdId, body, req) {
  const { membership } = await requirePermission(userId, householdId, 'transaction.create');
  const hid = membership.householdId; const db = getDb(); const client = getClient();
  const key = String(body.idempotencyKey || '').trim(); const records = Array.isArray(body.records) ? body.records : [];
  if (!key) throw apiError(400, 'VALIDATION_ERROR', 'An idempotency key is required.', 'idempotencyKey');
  if (records.length > 500) throw apiError(400, 'VALIDATION_ERROR', 'Import at most 500 records at a time.', 'records');
  const eventId = `bulk:${hid.toHexString()}:${key}`;
  const existing = await db.collection('domain_events').findOne({ eventId });
  if (existing?.payload?.result) return existing.payload.result;
  const session = client.startSession(); let result;
  try {
    await session.withTransaction(async () => {
      let inserted = 0, skippedDuplicates = 0, failed = 0; const skipped = [];
      for (const raw of records) {
        try {
          const { categoryId: importCategoryId, ...transactionInput } = raw;
          const clean = sanitizeRecordBody('transactions', transactionInput, 'create');
          if (clean.importReference) {
            const dup = await db.collection('transactions').findOne({ householdId: hid, importReference: clean.importReference }, { session });
            if (dup) { skippedDuplicates++; skipped.push({ importReference: clean.importReference, reason: 'DUPLICATE' }); continue; }
          }
          const now = new Date(); const txn = {
            ...clean, householdId: hid, version: 1, isDeleted: false, createdAt: now, updatedAt: now,
            createdBy: userId, updatedBy: userId, source: 'IMPORT', visibility: 'HOUSEHOLD', status: clean.status || 'ACTIVE'
          };
          const tr = await db.collection('transactions').insertOne(txn, { session }); txn._id = tr.insertedId; inserted++;
          if (raw.transactionType === 'EXPENSE' && importCategoryId) {
            const expense = {
              householdId: hid, accountId: clean.accountId || null, amount: clean.amount, baseAmount: clean.amount,
              baseCurrency: raw.currency || null, fxRate: Decimal128.fromString('1'), expenseDate: clean.transactionDate,
              merchant: clean.merchant || null, description: clean.description || null, categoryId: asObjectId(importCategoryId, 'categoryId'),
              ownership: 'HOUSEHOLD', nature: 'VARIABLE', costType: 'ESSENTIAL', planningType: 'UNPLANNED', spendingType: 'NEED',
              paymentMethod: 'NETBANKING', reimbursementStatus: 'NOT_APPLICABLE', currency: raw.currency || null,
              status: 'ACTIVE', version: 1, isDeleted: false, source: 'IMPORT', visibility: 'HOUSEHOLD',
              createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId
            };
            const er = await db.collection('expenses').insertOne(expense, { session }); expense._id = er.insertedId;
            await db.collection('transactions').updateOne({ _id: txn._id }, { $set: { linkedEntityType: 'expenses', linkedEntityId: expense._id } }, { session });
            await upsertSearchDocument(db, session, 'expenses', expense);
          }
          await upsertSearchDocument(db, session, 'transactions', txn);
        } catch (e) {
          if (e?.code === 11000) { skippedDuplicates++; skipped.push({ importReference: raw.importReference || null, reason: 'DUPLICATE' }); }
          else { failed++; skipped.push({ importReference: raw.importReference || null, reason: 'INVALID' }); }
        }
      }
      result = { inserted, skippedDuplicates, failed, skipped };
      await db.collection('domain_events').insertOne({ eventId, eventType: 'TRANSACTIONS_BULK_IMPORTED', householdId: hid, payload: { result, sourceDocumentId: body.sourceDocumentId || null, correlationId: correlationId(req) }, occurredAt: new Date(), processingStatus: 'PROCESSED', attempts: 1 }, { session });
    });
  } finally { await session.endSession(); }
  return result;
}

async function uploadDocument(userId, householdId, file, fields, req) {
  const { membership } = await requirePermission(userId, householdId, 'document.create');
  if (!file) throw apiError(400, 'VALIDATION_ERROR', 'Choose a document to upload.', 'file');
  if (file.size > MAX_UPLOAD_BYTES) throw apiError(400, 'VALIDATION_ERROR', 'The document must be 12 MB or smaller.', 'file');
  if (!ALLOWED_UPLOAD_MIME.has(file.mimetype)) throw apiError(400, 'VALIDATION_ERROR', 'That document type is not supported.', 'file');
  const bucket = documentBucket();
  const stream = bucket.openUploadStream(file.originalname, { metadata: { householdId: membership.householdId, uploadedBy: userId, mimeType: file.mimetype } });
  await new Promise((resolve, reject) => { stream.once('error', reject); stream.once('finish', resolve); stream.end(file.buffer); });
  const now = new Date(); const db = getDb();
  const doc = {
    householdId: membership.householdId, documentType: fields.documentType || 'UNKNOWN', filename: file.originalname,
    mimeType: file.mimetype, storageType: 'GRIDFS', storageReference: stream.id,
    pageCount: file.mimetype.startsWith('image/') ? 1 : null, fileSizeBytes: file.size,
    processingStatus: 'PENDING', uploadedBy: userId, uploadedAt: now,
    status: 'ACTIVE', version: 1, isDeleted: false, visibility: 'HOUSEHOLD', source: 'MANUAL',
    createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId
  };
  const r = await db.collection('documents').insertOne(doc); doc._id = r.insertedId;
  await db.collection('domain_events').insertOne({ eventId: crypto.randomUUID(), eventType: 'DOCUMENTS_CREATED', householdId: membership.householdId, payload: { entityId: doc._id, correlationId: correlationId(req) }, occurredAt: now, processingStatus: 'PENDING', attempts: 0 });
  return serialize(doc);
}

async function getDocumentContent(userId, householdId, id, res) {
  const { membership } = await requirePermission(userId, householdId, 'document.read');
  const vis = await visibilityFilter(membership, 'documents');
  const doc = await getDb().collection('documents').findOne({ $and: [{ _id: asObjectId(id), householdId: membership.householdId, isDeleted: { $ne: true } }, vis] });
  if (!doc) throw apiError(404, 'NOT_FOUND', 'That record no longer exists.');
  res.setHeader('content-type', doc.mimeType || 'application/octet-stream');
  res.setHeader('content-disposition', `inline; filename="${String(doc.filename || 'document').replace(/"/g,'')}"`);
  documentBucket().openDownloadStream(doc.storageReference).on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }).pipe(res);
}

function exportToken(jobId, userId, householdId, expiresAt) {
  const secret = process.env.EXPORT_SIGNING_SECRET || process.env.JWT_ACCESS_SECRET || process.env.FAMFIN_APP_TOKEN;
  if (!secret) throw new Error('EXPORT_SIGNING_SECRET or JWT_ACCESS_SECRET is required.');
  return jwt.sign({ typ: 'export', jobId, userId, householdId }, secret, { algorithm: 'HS256', expiresIn: Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) });
}

async function requestExport(userId, householdId, body, req) {
  const { membership } = await requirePermission(userId, householdId, 'export.create');
  const format = String(body.format || '').toUpperCase(); if (!['JSON','CSV','PDF'].includes(format)) throw apiError(400, 'VALIDATION_ERROR', 'Choose JSON, CSV, or PDF.', 'format');
  const scope = String(body.scope || 'MINE').toUpperCase(); if (!['MINE','HOUSEHOLD'].includes(scope)) throw apiError(400, 'VALIDATION_ERROR', 'Choose a valid export scope.', 'scope');
  if (scope === 'HOUSEHOLD' && req.get('x-step-up') !== 'verified') throw apiError(401, 'STEP_UP_REQUIRED', 'Confirm your password to export household data.');
  const modules = Array.isArray(body.modules) ? body.modules.filter(x => GENERIC_COLLECTIONS.includes(x)) : [];
  const now = new Date(), expiresAt = new Date(Date.now() + 24 * 3600000);
  const doc = {
    userId, householdId: membership.householdId, scope: scope === 'MINE' ? 'SELF' : 'HOUSEHOLD', format,
    status: 'QUEUED', requestedAt: now, expiresAt, modules, personalBackup: !!body.personalBackup,
    createdAt: now, updatedAt: now, version: 1, isDeleted: false, source: 'SYSTEM', visibility: 'PRIVATE'
  };
  const r = await getDb().collection('data_export_jobs').insertOne(doc); doc._id = r.insertedId;
  return serialize({ _id: doc._id, status: doc.status, requestedAt: doc.requestedAt, expiresAt: doc.expiresAt });
}

async function downloadExport(userId, householdId, id) {
  const membership = await getMembership(userId, householdId); const db = getDb();
  const job = await db.collection('data_export_jobs').findOne({ _id: asObjectId(id), householdId: membership.householdId, userId });
  if (!job) throw apiError(404, 'NOT_FOUND', 'That export no longer exists.');
  if (job.expiresAt && job.expiresAt <= new Date()) throw apiError(410, 'EXPIRED', 'That export link has expired. Create a new export.');
  if (job.status !== 'DONE' || !job.fileReference) throw apiError(404, 'NOT_READY', 'Your export is still being prepared.');
  const token = exportToken(job._id.toHexString(), userId.toHexString(), membership.householdId.toHexString(), job.expiresAt);
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return { url: `${base}/api/exports/files/${job._id.toHexString()}?token=${encodeURIComponent(token)}`, expiresAt: job.expiresAt.toISOString() };
}

async function streamExportFile(jobId, token, res) {
  const secret = process.env.EXPORT_SIGNING_SECRET || process.env.JWT_ACCESS_SECRET || process.env.FAMFIN_APP_TOKEN;
  let payload; try { payload = jwt.verify(token, secret, { algorithms: ['HS256'] }); } catch { return res.status(410).end(); }
  if (payload.typ !== 'export' || payload.jobId !== jobId) return res.status(403).end();
  const job = await getDb().collection('data_export_jobs').findOne({ _id: asObjectId(jobId) });
  if (!job || job.expiresAt <= new Date() || !job.fileReference) return res.status(410).end();
  const contentType = job.format === 'JSON' ? 'application/json' : job.format === 'CSV' ? 'text/csv' : 'application/pdf';
  res.setHeader('content-type', contentType);
  res.setHeader('content-disposition', `attachment; filename="famfin-export-${job._id.toHexString()}.${job.format.toLowerCase()}"`);
  exportBucket().openDownloadStream(asObjectId(job.fileReference, 'fileReference')).pipe(res);
}

async function buildExportBuffer(job) {
  const db = getDb(); const modules = job.modules?.length ? job.modules : ['expenses','transactions','income_events','accounts','loans','investments','goals'];
  const data = {}; const membership = await db.collection('household_users').findOne({ householdId: job.householdId, userId: job.userId, status: 'ACTIVE' });
  for (const collection of modules) {
    let filter = { householdId: job.householdId, isDeleted: { $ne: true } };
    if (job.scope === 'SELF' && membership?.familyMemberId) filter = { ...filter, $or: [{ ownerMemberId: membership.familyMemberId }, { paidByMemberId: membership.familyMemberId }, { createdBy: job.userId }] };
    data[collection] = serialize(await db.collection(collection).find(filter).toArray());
  }
  if (job.format === 'JSON') return Buffer.from(JSON.stringify({ householdId: job.householdId.toHexString(), generatedAt: new Date().toISOString(), modules: data }, null, 2));
  if (job.format === 'CSV') {
    const lines = ['module,record_json'];
    for (const [module, rows] of Object.entries(data)) for (const row of rows) lines.push(`${JSON.stringify(module)},${JSON.stringify(JSON.stringify(row))}`);
    return Buffer.from(lines.join('\n'));
  }
  return await new Promise((resolve, reject) => {
    const chunks = []; const pdf = new PDFDocument({ margin: 36 });
    pdf.on('data', c => chunks.push(c)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject);
    pdf.fontSize(18).text('FamFin Household Export'); pdf.moveDown();
    pdf.fontSize(9).text(`Generated: ${new Date().toISOString()}`); pdf.moveDown();
    for (const [module, rows] of Object.entries(data)) {
      pdf.fontSize(14).text(module); pdf.fontSize(7);
      for (const row of rows) { pdf.text(JSON.stringify(row)); pdf.moveDown(0.3); if (pdf.y > 740) pdf.addPage(); }
      pdf.moveDown();
    }
    pdf.end();
  });
}

async function processQueuedExports() {
  const db = getDb();
  const job = await db.collection('data_export_jobs').findOneAndUpdate(
    { status: 'QUEUED', expiresAt: { $gt: new Date() } }, { $set: { status: 'RUNNING', updatedAt: new Date() } }, { sort: { requestedAt: 1 }, returnDocument: 'after' }
  );
  if (!job) return false;
  try {
    const buffer = await buildExportBuffer(job);
    const bucket = exportBucket(); const stream = bucket.openUploadStream(`famfin-${job._id}.${job.format.toLowerCase()}`, { metadata: { jobId: job._id, householdId: job.householdId } });
    await new Promise((resolve, reject) => { stream.once('error', reject); stream.once('finish', resolve); stream.end(buffer); });
    await db.collection('data_export_jobs').updateOne({ _id: job._id }, { $set: { status: 'DONE', fileReference: stream.id.toHexString(), completedAt: new Date(), updatedAt: new Date() } });
  } catch (e) {
    console.error('Export job failed', job._id.toHexString(), e);
    await db.collection('data_export_jobs').updateOne({ _id: job._id }, { $set: { status: 'FAILED', updatedAt: new Date() } });
  }
  return true;
}

function startExportWorker() {
  const tick = async () => {
    try { while (await processQueuedExports()) {} } catch (e) { console.error('Export worker error', e); }
  };
  setInterval(tick, Number(process.env.EXPORT_WORKER_INTERVAL_MS || 5000)).unref();
  setTimeout(tick, 1000).unref();
}

module.exports = {
  responseEnvelope, createHousehold, getHousehold, updateHousehold, getMe,
  payBill, search, getPreferences, updatePreferences, getNotificationPreferences,
  updateNotificationPreferences, getEntitlements, verifySubscription, bulkTransactions,
  uploadDocument, getDocumentContent, requestExport, downloadExport, streamExportFile,
  startExportWorker
};
