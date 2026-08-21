const crypto = require('crypto');
const { ObjectId, Decimal128 } = require('mongodb');
const { getDb, getClient } = require('./db');
const { apiError } = require('./errors');
const { GENERIC_COLLECTIONS, COLLECTION_CONFIG, DEFAULT_SORT } = require('./constants');
const { requireCollectionPermission, visibilityFilter } = require('./permissions');
const {
  asObjectId, serialize, sanitizeRecordBody, encodeCursor, decodeCursor,
  correlationId, humanCollectionEvent, parseMoney
} = require('./utils');

function guardCollection(name) {
  if (!GENERIC_COLLECTIONS.includes(name)) throw apiError(404, 'NOT_FOUND', 'That record type does not exist.');
  return name;
}

function listSort(collection) {
  return DEFAULT_SORT[collection] || [{ field: 'createdAt', dir: -1 }];
}

function mongoSort(sortSpec) {
  const out = {};
  for (const s of sortSpec) out[s.field] = s.dir;
  out._id = -1;
  return out;
}

function cursorValueToMongo(field, value) {
  if (value == null) return value;
  if (field === '_id') return asObjectId(value, 'cursor');
  if (['createdAt','expenseDate','transactionDate','detectedAt'].includes(field)) return new Date(value);
  return value;
}

function buildCursorFilter(collection, decoded) {
  const spec = listSort(collection);
  if (!decoded || !decoded._id) return {};
  const lastId = asObjectId(decoded._id, 'cursor');
  if (collection === 'notifications') {
    const readAt = decoded.readAt ? new Date(decoded.readAt) : null;
    const createdAt = new Date(decoded.createdAt);
    if (readAt === null) {
      return { $or: [
        { readAt: null, createdAt: { $lt: createdAt } },
        { readAt: null, createdAt, _id: { $lt: lastId } },
        { readAt: { $ne: null } }
      ] };
    }
    return { $or: [
      { readAt: { $gt: readAt } },
      { readAt, createdAt: { $lt: createdAt } },
      { readAt, createdAt, _id: { $lt: lastId } }
    ] };
  }
  const s = spec[0];
  const value = cursorValueToMongo(s.field, decoded[s.field]);
  const op = s.dir === -1 ? '$lt' : '$gt';
  return { $or: [
    { [s.field]: { [op]: value } },
    { [s.field]: value, _id: { $lt: lastId } }
  ] };
}

function cursorFromRecord(collection, record) {
  const out = { _id: record._id };
  for (const s of listSort(collection)) out[s.field] = record[s.field] ?? null;
  return encodeCursor(out);
}

function andFilters(...filters) {
  const active = filters.filter(f => f && Object.keys(f).length);
  if (!active.length) return {};
  if (active.length === 1) return active[0];
  return { $and: active };
}

async function scopedReadFilter(collection, householdId, membership) {
  const hid = asObjectId(householdId, 'householdId');
  const visibility = await visibilityFilter(membership, collection);
  if (collection === 'expense_categories') {
    return andFilters({ $or: [{ householdId: hid }, { householdId: null }] }, { isDeleted: { $ne: true } });
  }
  return andFilters({ householdId: hid }, { isDeleted: { $ne: true } }, visibility);
}

async function listRecords(userId, householdId, collection, query) {
  guardCollection(collection);
  const { membership } = await requireCollectionPermission(userId, householdId, collection, 'read');
  const limit = Math.min(Math.max(Number(query.limit || 25) || 25, 1), 100);
  const base = await scopedReadFilter(collection, householdId, membership);
  const status = query.status ? { status: String(query.status) } : {};
  const cursor = query.cursor ? buildCursorFilter(collection, decodeCursor(query.cursor)) : {};
  const filter = andFilters(base, status, cursor);
  const docs = await getDb().collection(collection).find(filter).sort(mongoSort(listSort(collection))).limit(limit + 1).toArray();
  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const nextCursor = hasMore && page.length ? cursorFromRecord(collection, page[page.length - 1]) : null;
  return { data: serialize(page), meta: { nextCursor, hasMore } };
}

async function getOne(userId, householdId, collection, id) {
  guardCollection(collection);
  const { membership } = await requireCollectionPermission(userId, householdId, collection, 'read');
  const base = await scopedReadFilter(collection, householdId, membership);
  const doc = await getDb().collection(collection).findOne(andFilters(base, { _id: asObjectId(id) }));
  if (!doc) throw apiError(404, 'NOT_FOUND', 'That record no longer exists.');
  return serialize(doc);
}

async function emitDomainEvent(db, session, collection, action, householdId, entityId, reqCorrelationId, payload = {}) {
  await db.collection('domain_events').insertOne({
    eventId: crypto.randomUUID(),
    eventType: humanCollectionEvent(collection, action),
    householdId,
    payload: { entityId, correlationId: reqCorrelationId, ...payload },
    occurredAt: new Date(), processingStatus: 'PENDING', attempts: 0
  }, { session });
}

async function enqueueSearchJob(db, session, householdId, collection, entityId, action = 'UPSERT') {
  await db.collection('background_jobs').insertOne({
    jobType: 'SEARCH_INDEX_UPDATE', householdId, status: 'QUEUED', runAfter: new Date(), attempts: 0,
    payload: { collection, entityId, action }
  }, { session });
}

function searchTitle(collection, doc) {
  return doc.title || doc.name || doc.merchant || doc.description || doc.filename || doc.provider || `${collection} record`;
}
function searchDate(doc) {
  return doc.expenseDate || doc.transactionDate || doc.dueDate || doc.detectedAt || doc.decisionDate || doc.periodStart || doc.createdAt || new Date();
}
function searchAmount(doc) {
  return doc.amount || doc.currentValue || doc.targetAmount || doc.expectedAmount || doc.totalAmount || null;
}

async function upsertSearchDocument(db, session, collection, doc) {
  if (!doc?._id || !doc.householdId || collection === 'notifications') return;
  const memberIds = [doc.ownerMemberId, doc.paidByMemberId, ...(doc.beneficiaryMemberIds || []), ...(doc.ownerMemberIds || [])].filter(Boolean);
  const title = String(searchTitle(collection, doc));
  const keywords = [doc.merchant, doc.provider, doc.categoryGroup, doc.type, doc.status].filter(Boolean).map(String);
  const searchText = Object.entries(serialize(doc))
    .filter(([k,v]) => typeof v === 'string' && !['notes'].includes(k))
    .map(([,v]) => v).join(' ').slice(0, 12000);
  const now = new Date();
  await db.collection('search_documents').updateOne(
    { householdId: doc.householdId, entityType: collection, entityId: doc._id },
    {
      $set: {
        title, keywords, searchText, amount: searchAmount(doc), date: searchDate(doc), memberIds,
        updatedAt: now, isDeleted: false, version: 1, visibility: 'HOUSEHOLD'
      },
      $setOnInsert: { householdId: doc.householdId, entityType: collection, entityId: doc._id, createdAt: now, source: 'SYSTEM' }
    },
    { upsert: true, session }
  );
}

async function removeSearchDocument(db, session, householdId, collection, entityId) {
  await db.collection('search_documents').deleteOne({ householdId, entityType: collection, entityId }, { session });
}

function createBase(hid, userId, body) {
  const now = new Date();
  return {
    ...body,
    householdId: hid,
    version: 1,
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    updatedBy: userId,
    status: body.status || 'ACTIVE',
    visibility: body.visibility || 'HOUSEHOLD',
    source: body.source || 'MANUAL'
  };
}

async function enforceCreateRules(db, session, collection, hid, userId, clean, fullDoc) {
  if (collection === 'family_members' && clean.relationship === 'SELF') {
    const existing = await db.collection('family_members').findOne({ householdId: hid, relationship: 'SELF', isDeleted: { $ne: true } }, { session });
    if (existing) throw apiError(400, 'VALIDATION_ERROR', 'This household already has a SELF family member.', 'relationship');
  }
  if (collection === 'income_sources' && clean.isVariable === true && clean.includeInBudget === undefined) fullDoc.includeInBudget = false;
  if (COLLECTION_CONFIG[collection].singleton) {
    const existing = await db.collection(collection).findOne({ householdId: hid, isDeleted: { $ne: true } }, { session });
    if (existing) throw apiError(409, 'VERSION_CONFLICT', 'This household already has that plan.', undefined, { remote: serialize(existing) });
  }
}

function severityRank(s) {
  return ({ INFO: 1, ATTENTION: 2, HIGH: 3, CRITICAL: 4 })[s] || 0;
}

async function createRecord(userId, householdId, collection, body, req) {
  guardCollection(collection);
  const { membership } = await requireCollectionPermission(userId, householdId, collection, 'create');
  const hid = membership.householdId;
  const clean = sanitizeRecordBody(collection, body, 'create');
  const db = getDb();
  const client = getClient();
  const session = client.startSession();
  let saved;
  let status = 201;
  try {
    await session.withTransaction(async () => {
      let doc = createBase(hid, userId, clean);
      await enforceCreateRules(db, session, collection, hid, userId, clean, doc);

      if (COLLECTION_CONFIG[collection].upsertByDedupe) {
        const old = await db.collection(collection).findOne({ householdId: hid, dedupeKey: clean.dedupeKey, isDeleted: { $ne: true } }, { session });
        if (old) {
          const { version: _newVersion, ...docWithoutVersion } = doc;
          const preserve = { status: old.status, acceptedVariance: old.acceptedVariance, snoozedUntil: old.snoozedUntil, createdAt: old.createdAt, createdBy: old.createdBy };
          await db.collection(collection).updateOne({ _id: old._id }, { $set: { ...docWithoutVersion, ...preserve, updatedAt: new Date(), updatedBy: userId }, $inc: { version: 1 } }, { session });
          saved = await db.collection(collection).findOne({ _id: old._id }, { session });
          status = 201;
        }
      }

      if (!saved && COLLECTION_CONFIG[collection].notificationDedupe && clean.dedupeKey) {
        const old = await db.collection(collection).findOne({ householdId: hid, userId: clean.userId, dedupeKey: clean.dedupeKey, readAt: null, isDeleted: { $ne: true } }, { session });
        if (old) {
          if (severityRank(clean.severity) > severityRank(old.severity)) {
            await db.collection(collection).updateOne({ _id: old._id }, { $set: { ...clean, updatedAt: new Date(), updatedBy: userId }, $inc: { version: 1 } }, { session });
            saved = await db.collection(collection).findOne({ _id: old._id }, { session });
          } else saved = old;
          status = 201;
        }
      }

      if (!saved) {
        const r = await db.collection(collection).insertOne(doc, { session });
        doc._id = r.insertedId;
        saved = doc;
      }

      if (COLLECTION_CONFIG[collection].incrementGoalOnCreate) {
        const amount = saved.amount;
        const goal = await db.collection('goals').findOneAndUpdate(
          { _id: saved.goalId, householdId: hid, isDeleted: { $ne: true } },
          { $inc: { currentAmount: amount, version: 1 }, $set: { updatedAt: new Date(), updatedBy: userId } },
          { returnDocument: 'after', session }
        );
        if (!goal) throw apiError(400, 'VALIDATION_ERROR', 'Choose a valid goal.', 'goalId');
      }

      const cid = correlationId(req);
      await emitDomainEvent(db, session, collection, 'CREATED', hid, saved._id, cid);
      await upsertSearchDocument(db, session, collection, saved);
      await enqueueSearchJob(db, session, hid, collection, saved._id);
    });
  } catch (e) {
    if (e?.code === 11000) {
      if (collection === 'emergency_fund_plans') throw apiError(409, 'VERSION_CONFLICT', 'This household already has an emergency fund plan.');
      throw apiError(400, 'VALIDATION_ERROR', 'That record already exists.');
    }
    throw e;
  } finally { await session.endSession(); }
  return { status, data: serialize(saved) };
}

function parseVersion(req) {
  const raw = req.get('if-match') ?? req.body?.version;
  if (raw === undefined || raw === null || raw === '') throw apiError(428, 'VERSION_REQUIRED', 'Refresh this information and try again.');
  const cleaned = String(raw).replace(/^W\//, '').replace(/"/g, '');
  const version = Number(cleaned);
  if (!Number.isInteger(version) || version < 1) throw apiError(428, 'VERSION_REQUIRED', 'Refresh this information and try again.');
  return version;
}

async function ensureMutable(collection, current, clean, hid) {
  if (collection === 'expense_categories' && current.householdId === null) throw apiError(403, 'FORBIDDEN', 'System categories cannot be changed.');
  if (COLLECTION_CONFIG[collection].appendOnly) {
    const mutable = new Set(['effectiveTo','status','notes']);
    for (const key of Object.keys(clean)) if (!mutable.has(key)) throw apiError(400, 'VALIDATION_ERROR', 'Salary structures are append-only. Create a new structure for changed pay.', key);
  }
  if (COLLECTION_CONFIG[collection].payViaSpecial && clean.status === 'PAID' && current.status !== 'PAID') {
    throw apiError(400, 'VALIDATION_ERROR', 'Use the pay-bill endpoint to mark a bill paid.', 'status');
  }
  if (COLLECTION_CONFIG[collection].immutableWhenClosed) {
    const point = current.periodStart;
    const closed = await getDb().collection('financial_periods').findOne({ householdId: hid, status: 'CLOSED', startDate: { $lte: point }, endDate: { $gte: point } });
    if (closed) throw apiError(403, 'FORBIDDEN', 'A closed financial period cannot be changed.');
  }
}

async function updateRecord(userId, householdId, collection, id, body, req) {
  guardCollection(collection);
  const { membership } = await requireCollectionPermission(userId, householdId, collection, 'update');
  const hid = membership.householdId;
  const oid = asObjectId(id);
  const version = parseVersion(req);
  const clean = sanitizeRecordBody(collection, body, 'update');
  for (const f of COLLECTION_CONFIG[collection].serverOwnedAfterCreate || []) delete clean[f];
  const db = getDb();
  const client = getClient();
  const session = client.startSession();
  let saved;
  try {
    await session.withTransaction(async () => {
      const currentFilter = collection === 'expense_categories'
        ? { _id: oid, $or: [{ householdId: hid }, { householdId: null }], isDeleted: { $ne: true } }
        : { _id: oid, householdId: hid, isDeleted: { $ne: true } };
      const current = await db.collection(collection).findOne(currentFilter, { session });
      if (!current) throw apiError(404, 'NOT_FOUND', 'That record no longer exists.');
      if (current.version !== version) throw apiError(409, 'VERSION_CONFLICT', 'This information was changed on another device. Refresh and review the latest version.', undefined, { remote: serialize(current) });
      await ensureMutable(collection, current, clean, hid);
      const r = await db.collection(collection).findOneAndUpdate(
        { _id: oid, householdId: hid, version, isDeleted: { $ne: true } },
        { $set: { ...clean, updatedAt: new Date(), updatedBy: userId }, $inc: { version: 1 } },
        { returnDocument: 'after', session }
      );
      if (!r) {
        const remote = await db.collection(collection).findOne({ _id: oid, householdId: hid }, { session });
        if (remote) throw apiError(409, 'VERSION_CONFLICT', 'This information was changed on another device. Refresh and review the latest version.', undefined, { remote: serialize(remote) });
        throw apiError(404, 'NOT_FOUND', 'That record no longer exists.');
      }
      saved = r;
      const cid = correlationId(req);
      await emitDomainEvent(db, session, collection, 'UPDATED', hid, oid, cid);
      await upsertSearchDocument(db, session, collection, saved);
      await enqueueSearchJob(db, session, hid, collection, oid);
    });
  } finally { await session.endSession(); }
  return serialize(saved);
}

async function deleteRecord(userId, householdId, collection, id, req) {
  guardCollection(collection);
  const { membership } = await requireCollectionPermission(userId, householdId, collection, 'delete');
  const hid = membership.householdId;
  const oid = asObjectId(id);
  const db = getDb();
  const client = getClient();
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const currentFilter = collection === 'expense_categories'
        ? { _id: oid, $or: [{ householdId: hid }, { householdId: null }], isDeleted: { $ne: true } }
        : { _id: oid, householdId: hid, isDeleted: { $ne: true } };
      const current = await db.collection(collection).findOne(currentFilter, { session });
      if (!current) throw apiError(404, 'NOT_FOUND', 'That record no longer exists.');
      if (collection === 'expense_categories' && current.householdId === null) throw apiError(403, 'FORBIDDEN', 'System categories cannot be deleted.');
      await db.collection(collection).updateOne(
        { _id: oid, householdId: hid, isDeleted: { $ne: true } },
        { $set: { isDeleted: true, deletedAt: new Date(), updatedAt: new Date(), updatedBy: userId }, $inc: { version: 1 } },
        { session }
      );
      const cid = correlationId(req);
      await emitDomainEvent(db, session, collection, 'DELETED', hid, oid, cid);
      await removeSearchDocument(db, session, hid, collection, oid);
      await enqueueSearchJob(db, session, hid, collection, oid, 'DELETE');
    });
  } finally { await session.endSession(); }
  return { deleted: true };
}

module.exports = {
  guardCollection, listRecords, getOne, createRecord, updateRecord, deleteRecord,
  parseVersion, upsertSearchDocument, emitDomainEvent, enqueueSearchJob
};
