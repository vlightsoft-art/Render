const { MongoClient, GridFSBucket } = require('mongodb');

let client;
let db;

async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured.');
  const dbName = process.env.MONGODB_DB || 'family_finance';
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 });
  await client.connect();
  db = client.db(dbName);
  await db.command({ ping: 1 });
  return db;
}

function getDb() {
  if (!db) throw new Error('Database is not connected.');
  return db;
}

function getClient() {
  if (!client) throw new Error('Database is not connected.');
  return client;
}

function documentBucket() {
  return new GridFSBucket(getDb(), { bucketName: 'financial_documents' });
}

function exportBucket() {
  return new GridFSBucket(getDb(), { bucketName: 'famfin_exports' });
}

async function closeDatabase() {
  if (client) await client.close();
}

async function ensureRuntimeCollections() {
  const db = getDb();
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name));
  for (const name of ['auth_credentials','auth_sessions','auth_rate_limits','household_invitations','invite_redeem_rate_limits']) {
    if (!existing.has(name)) await db.createCollection(name);
  }
  await db.collection('auth_credentials').createIndex({ userId: 1 }, { unique: true, name: 'uniq_user' });
  await db.collection('auth_credentials').createIndex({ email: 1 }, { unique: true, name: 'uniq_email' });
  await db.collection('auth_sessions').createIndex({ tokenHash: 1 }, { unique: true, name: 'uniq_refresh_hash' });
  await db.collection('auth_sessions').createIndex({ familyId: 1, revokedAt: 1 }, { name: 'by_family' });
  await db.collection('auth_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expires' });
  await db.collection('auth_rate_limits').createIndex({ key: 1 }, { unique: true, name: 'uniq_key' });
  await db.collection('auth_rate_limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expires' });

  // Family sharing runtime state. These are server-side transport/auth
  // collections, not financial business collections.
  await db.collection('household_invitations').createIndex(
    { inviteCode: 1 },
    { unique: true, name: 'uniq_invite_code', partialFilterExpression: { inviteCode: { $type: 'string' } } }
  );
  await db.collection('household_invitations').createIndex(
    { householdId: 1, status: 1, createdAt: -1 },
    { name: 'by_household_status' }
  );
  await db.collection('household_invitations').createIndex(
    { householdId: 1, email: 1, status: 1 },
    { name: 'by_household_email_status' }
  );
  await db.collection('household_invitations').createIndex(
    { expiresAt: 1, status: 1 },
    { name: 'by_expiry_status' }
  );
  await db.collection('invite_redeem_rate_limits').createIndex({ key: 1 }, { unique: true, name: 'uniq_key' });
  await db.collection('invite_redeem_rate_limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expires' });

  // Contract requires a sparse UNIQUE importReference per household. Repair the
  // earlier initializer if it created the named index without unique:true.
  const txnIndexes = await db.collection('transactions').indexes();
  const importIdx = txnIndexes.find(i => i.name === 'by_import_ref');
  if (importIdx && !importIdx.unique) {
    const duplicates = await db.collection('transactions').aggregate([
      { $match: { importReference: { $exists: true, $ne: null } } },
      { $group: { _id: { householdId: '$householdId', importReference: '$importReference' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } }, { $limit: 1 }
    ]).toArray();
    if (duplicates.length) throw new Error('Cannot make transactions.by_import_ref unique because duplicate import references already exist.');
    await db.collection('transactions').dropIndex('by_import_ref');
    await db.collection('transactions').createIndex(
      { householdId: 1, importReference: 1 },
      { unique: true, sparse: true, name: 'by_import_ref' }
    );
  } else if (!importIdx) {
    await db.collection('transactions').createIndex(
      { householdId: 1, importReference: 1 },
      { unique: true, sparse: true, name: 'by_import_ref' }
    );
  }
}

module.exports = { connectDatabase, getDb, getClient, closeDatabase, ensureRuntimeCollections, documentBucket, exportBucket };
