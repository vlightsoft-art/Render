const crypto = require('crypto');
const { ObjectId, Decimal128 } = require('mongodb');
const { apiError } = require('./errors');
const { COLLECTION_CONFIG, SERVER_MANAGED_FIELDS } = require('./constants');

const DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function asObjectId(value, field = 'id') {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof ObjectId) return value;
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value)) {
    throw apiError(400, 'VALIDATION_ERROR', `Enter a valid ${field}.`, field);
  }
  return new ObjectId(value);
}

function parseMoney(value, field) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string' || !DECIMAL_RE.test(value.trim())) {
    throw apiError(400, 'VALIDATION_ERROR', 'Enter a valid decimal amount.', field);
  }
  return Decimal128.fromString(value.trim());
}

function parseDate(value, field) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') throw apiError(400, 'VALIDATION_ERROR', 'Enter a valid date and time.', field);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw apiError(400, 'VALIDATION_ERROR', 'Enter a valid date and time.', field);
  return d;
}

function serialize(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Decimal128) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out;
  }
  return value;
}

function sanitizeRecordBody(collection, body, mode = 'create') {
  const config = COLLECTION_CONFIG[collection];
  if (!config) throw apiError(404, 'NOT_FOUND', 'That record type does not exist.');
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const allowed = new Set(config.fields);
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (SERVER_MANAGED_FIELDS.has(key) || key === 'version') continue;
    if (!allowed.has(key)) throw apiError(400, 'VALIDATION_ERROR', `The field ${key} is not supported.`, key);
    out[key] = value;
  }
  if (mode === 'create') {
    for (const field of config.required || []) {
      if (out[field] === undefined || out[field] === null || out[field] === '') {
        throw apiError(400, 'VALIDATION_ERROR', `Enter ${field}.`, field);
      }
    }
  }
  for (const field of config.maskFields || []) {
    if (out[field] != null && String(out[field]).length > 4) {
      throw apiError(400, 'VALIDATION_ERROR', 'Enter only the last 4 characters.', field);
    }
  }
  for (const field of [...(config.money || []), ...(config.decimal || [])]) {
    if (field in out) out[field] = parseMoney(out[field], field);
  }
  for (const field of config.dates || []) {
    if (field in out) out[field] = parseDate(out[field], field);
  }
  for (const field of config.objectIds || []) {
    if (field in out) out[field] = asObjectId(out[field], field);
  }
  for (const field of config.objectIdArrays || []) {
    if (field in out && out[field] != null) {
      if (!Array.isArray(out[field])) throw apiError(400, 'VALIDATION_ERROR', 'Enter a valid list.', field);
      out[field] = out[field].map(v => asObjectId(v, field));
    }
  }
  if (config.storageReference && 'storageReference' in out && typeof out.storageReference === 'string' && /^[a-fA-F0-9]{24}$/.test(out.storageReference)) {
    out.storageReference = new ObjectId(out.storageReference);
  }
  if (collection === 'allocation_plans' && Array.isArray(out.items)) {
    out.items = out.items.map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw apiError(400, 'VALIDATION_ERROR', 'Enter a valid allocation item.', 'items');
      const x = { ...item };
      if (x.amount != null) x.amount = parseMoney(x.amount, `items[${i}].amount`);
      if (x.targetId != null) x.targetId = asObjectId(x.targetId, `items[${i}].targetId`);
      return x;
    });
  }
  if (collection === 'financial_snapshots' && out.categoryBreakdown && typeof out.categoryBreakdown === 'object' && !Array.isArray(out.categoryBreakdown)) {
    const mapped = {};
    for (const [k,v] of Object.entries(out.categoryBreakdown)) mapped[k] = parseMoney(v, `categoryBreakdown.${k}`);
    out.categoryBreakdown = mapped;
  }
  return out;
}

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(serialize(obj)), 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw apiError(400, 'VALIDATION_ERROR', 'The list cursor is invalid.', 'cursor'); }
}

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function correlationId(req) { return req.get('x-correlation-id') || `${Date.now()}-${crypto.randomInt(1000,9999)}`; }
function now() { return new Date(); }

function humanCollectionEvent(collection, action) {
  return `${collection.toUpperCase()}_${action.toUpperCase()}`;
}

module.exports = {
  asObjectId, parseMoney, parseDate, serialize, sanitizeRecordBody,
  encodeCursor, decodeCursor, randomToken, sha256, correlationId, now, humanCollectionEvent
};
