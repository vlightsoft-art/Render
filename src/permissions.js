const { ObjectId } = require('mongodb');
const { getDb } = require('./db');
const { apiError } = require('./errors');
const { PERMISSION_ENTITY, ALL_PERMISSION_ENTITIES, ALL_PERMISSION_ACTIONS } = require('./constants');
const { asObjectId } = require('./utils');

function allPermissions() {
  const out = [];
  for (const e of ALL_PERMISSION_ENTITIES) for (const a of ALL_PERMISSION_ACTIONS) out.push(`${e}.${a}`);
  return out;
}

async function getMembership(userId, householdId) {
  const db = getDb();
  const hid = asObjectId(householdId, 'householdId');
  const membership = await db.collection('household_users').findOne({ householdId: hid, userId, status: 'ACTIVE' });
  if (!membership) throw apiError(403, 'FORBIDDEN', 'You do not have access to this household.');
  return membership;
}

async function permissionsForMembership(membership) {
  if (membership.role === 'HOUSEHOLD_ADMIN') return allPermissions();
  const rows = await getDb().collection('role_permissions').find({ roleCode: membership.role }).project({ permissionCode: 1 }).toArray();
  return rows.map(r => r.permissionCode);
}

async function requirePermission(userId, householdId, permission) {
  const membership = await getMembership(userId, householdId);
  const permissions = await permissionsForMembership(membership);
  if (!permissions.includes(permission)) throw apiError(403, 'FORBIDDEN', 'You do not have permission to do that.');
  return { membership, permissions };
}

async function requireCollectionPermission(userId, householdId, collection, action) {
  const entity = PERMISSION_ENTITY[collection];
  if (!entity) throw apiError(404, 'NOT_FOUND', 'That record type does not exist.');
  return requirePermission(userId, householdId, `${entity}.${action}`);
}

async function sharedIdsFor(membership, collection) {
  if (!membership.familyMemberId) return [];
  return getDb().collection('record_shares').find({
    householdId: membership.householdId,
    entityType: collection,
    memberId: membership.familyMemberId,
    accessLevel: { $in: ['VIEW','EDIT'] },
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }]
  }).project({ entityId: 1 }).toArray().then(rows => rows.map(r => r.entityId));
}

async function visibilityFilter(membership, collection) {
  if (collection === 'expense_categories') return {};
  if (membership.role === 'HOUSEHOLD_ADMIN') {
    return { $or: [
      { visibility: { $exists: false } }, { visibility: null },
      { visibility: 'HOUSEHOLD' }, { visibility: 'ADMIN_ONLY' },
      { ownerMemberId: membership.familyMemberId }
    ] };
  }
  const shared = await sharedIdsFor(membership, collection);
  const memberId = membership.familyMemberId || new ObjectId('000000000000000000000000');
  const ors = [
    { visibility: { $exists: false } }, { visibility: null }, { visibility: 'HOUSEHOLD' },
    { visibility: 'PRIVATE', ownerMemberId: memberId },
    { visibility: 'SHARED_WITH_SELECTED', ownerMemberId: memberId }
  ];
  if (shared.length) ors.push({ visibility: 'SHARED_WITH_SELECTED', _id: { $in: shared } });
  return { $or: ors };
}

module.exports = {
  getMembership, permissionsForMembership, requirePermission, requireCollectionPermission,
  visibilityFilter, allPermissions
};
