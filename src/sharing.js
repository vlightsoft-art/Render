const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { getDb, getClient } = require('./db');
const { apiError } = require('./errors');
const { getMembership } = require('./permissions');
const { asObjectId, serialize } = require('./utils');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REDEEM_WINDOW_MS = 15 * 60 * 1000;
const REDEEM_MAX_ATTEMPTS = 10;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, avoids 0/O/1/I.

function sharingError(status, code, message, field) {
  const err = apiError(status, code, message, field);
  err.isSharingError = true;
  return err;
}

function wireRole(membershipOrRole) {
  if (!membershipOrRole) return 'MEMBER';
  if (typeof membershipOrRole === 'string') {
    if (membershipOrRole === 'HOUSEHOLD_ADMIN') return 'OWNER';
    if (membershipOrRole === 'VIEW_ONLY') return 'VIEWER';
    return membershipOrRole;
  }
  if (membershipOrRole.sharingRole) return membershipOrRole.sharingRole;
  if (membershipOrRole.role === 'HOUSEHOLD_ADMIN') return 'OWNER';
  if (membershipOrRole.role === 'VIEW_ONLY') return 'VIEWER';
  return membershipOrRole.role || 'MEMBER';
}

function internalRole(requestedRole) {
  const role = normalizeRole(requestedRole);
  if (role === 'OWNER' || role === 'ADMIN') return 'HOUSEHOLD_ADMIN';
  if (role === 'VIEWER') return 'VIEW_ONLY';
  if (['MEMBER', 'FINANCIAL_PARTNER', 'VIEW_ONLY', 'GOAL_CONTRIBUTOR'].includes(role)) return role;
  // Unknown future client roles are retained as sharingRole but receive the
  // least-privileged known server role until an explicit permission map exists.
  return 'MEMBER';
}

function normalizeRole(value) {
  const role = String(value || '').trim().toUpperCase();
  if (!role || !/^[A-Z][A-Z0-9_]{0,63}$/.test(role)) {
    throw sharingError(422, 'invalid_role', 'Choose a valid household role.', 'role');
  }
  return role;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw sharingError(422, 'invalid_email', 'Enter a valid email address.', 'email');
  }
  return email;
}

function normalizeDisplayName(value) {
  if (value == null) return null;
  const x = String(value).trim();
  return x || null;
}

function generateCode() {
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  return out;
}

async function uniqueInviteCode() {
  const db = getDb();
  for (let i = 0; i < 20; i++) {
    const code = generateCode();
    const exists = await db.collection('household_invitations').findOne({ inviteCode: code }, { projection: { _id: 1 } });
    if (!exists) return code;
  }
  throw sharingError(500, 'invite_code_error', 'Unable to create an invitation right now. Please retry.');
}

function isManager(membership) {
  const role = wireRole(membership);
  return role === 'OWNER' || role === 'ADMIN';
}

async function requireManager(userId, householdId) {
  const membership = await getMembership(userId, householdId);
  if (!isManager(membership)) {
    throw sharingError(403, 'forbidden', 'Only a household owner or admin can manage invitations.');
  }
  return membership;
}

function invitationBody(doc) {
  const out = {
    id: doc._id.toHexString(),
    email: doc.email,
    role: doc.role || 'MEMBER',
    status: doc.status,
  };
  if (doc.displayName) out.displayName = doc.displayName;
  if (doc.familyMemberIdRaw) out.familyMemberId = doc.familyMemberIdRaw;
  if (doc.inviteCode && doc.status === 'PENDING') out.inviteCode = doc.inviteCode;
  return out;
}

async function acceptedMemberBody(membership) {
  const db = getDb();
  const user = await db.collection('users').findOne(
    { _id: membership.userId },
    { projection: { primaryEmail: 1, preferredName: 1 } }
  );
  const familyMember = membership.familyMemberId
    ? await db.collection('family_members').findOne(
        { _id: membership.familyMemberId, householdId: membership.householdId, isDeleted: { $ne: true } },
        { projection: { name: 1 } }
      )
    : null;
  return {
    id: membership._id.toHexString(),
    email: user?.primaryEmail || '',
    role: wireRole(membership),
    status: 'ACCEPTED',
    displayName: familyMember?.name || user?.preferredName || user?.primaryEmail?.split('@')[0] || 'Member'
  };
}

async function expirePendingInvites(householdId = null) {
  const filter = { status: 'PENDING', expiresAt: { $lte: new Date() } };
  if (householdId) filter.householdId = householdId;
  await getDb().collection('household_invitations').updateMany(
    filter,
    { $set: { status: 'EXPIRED', inviteCode: null, updatedAt: new Date() } }
  );
}

async function sendInvitationEmail(invitation, household) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.INVITE_FROM_EMAIL;
  const appUrl = process.env.INVITE_APP_URL || process.env.PUBLIC_APP_URL || '';

  // The contract says the server sends the invitation email. In production,
  // fail rather than claim an email was sent when no mail provider is configured.
  if (!apiKey || !from) {
    if (process.env.NODE_ENV === 'production') {
      throw sharingError(503, 'email_unavailable', 'Invitation email is temporarily unavailable. Please retry.');
    }
    console.log(`[invite-email:dev] ${invitation.email} code=${invitation.inviteCode}`);
    return;
  }

  const recipient = invitation.displayName || invitation.email;
  const householdName = household?.name || 'a FamFin household';
  const joinText = appUrl ? `\nOpen FamFin: ${appUrl}` : '';
  const text = `${recipient},\n\nYou have been invited to join ${householdName} on FamFin.\nInvite code: ${invitation.inviteCode}\nThis code expires in 7 days.${joinText}\n`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [invitation.email],
      subject: `You're invited to ${householdName} on FamFin`,
      text
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('Invitation email delivery failed:', response.status, detail.slice(0, 500));
    throw sharingError(503, 'email_unavailable', 'Invitation email is temporarily unavailable. Please retry.');
  }
}

async function createInvitation(userId, householdId, body) {
  const manager = await requireManager(userId, householdId);
  const db = getDb();
  const hid = manager.householdId;
  const email = normalizeEmail(body?.email);
  const role = normalizeRole(body?.role);
  const displayName = normalizeDisplayName(body?.displayName);
  const familyMemberIdRaw = body?.familyMemberId == null ? null : String(body.familyMemberId).trim();

  await expirePendingInvites(hid);

  const existingUser = await db.collection('users').findOne(
    { primaryEmail: email, status: { $ne: 'DELETED' } },
    { projection: { _id: 1 } }
  );
  if (existingUser) {
    const already = await db.collection('household_users').findOne({ householdId: hid, userId: existingUser._id, status: 'ACTIVE' });
    if (already) throw sharingError(409, 'already_member', 'Already in this household.');
  }

  const pending = await db.collection('household_invitations').findOne({ householdId: hid, email, status: 'PENDING' });
  if (pending) throw sharingError(409, 'already_invited', 'An invitation is already pending for this email.');

  // If a cloud ObjectId is supplied, make sure it really belongs to this household.
  if (familyMemberIdRaw && /^[a-fA-F0-9]{24}$/.test(familyMemberIdRaw)) {
    const fm = await db.collection('family_members').findOne({
      _id: new ObjectId(familyMemberIdRaw), householdId: hid, isDeleted: { $ne: true }
    });
    if (!fm) throw sharingError(422, 'invalid_family_member', 'Choose a family member from this household.', 'familyMemberId');
  }

  const now = new Date();
  const invitation = {
    householdId: hid,
    email,
    role,
    internalRole: internalRole(role),
    status: 'PENDING',
    displayName,
    familyMemberIdRaw: familyMemberIdRaw || null,
    inviteCode: await uniqueInviteCode(),
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    acceptedBy: null,
    acceptedAt: null,
    revokedAt: null,
    membershipId: null
  };
  const result = await db.collection('household_invitations').insertOne(invitation);
  invitation._id = result.insertedId;

  try {
    const household = await db.collection('households').findOne({ _id: hid }, { projection: { name: 1 } });
    await sendInvitationEmail(invitation, household);
  } catch (e) {
    // Do not leave a live code behind when the server failed to perform its
    // responsibility of delivering the invitation.
    await db.collection('household_invitations').updateOne(
      { _id: invitation._id, status: 'PENDING' },
      { $set: { status: 'REVOKED', inviteCode: null, revokedAt: new Date(), updatedAt: new Date(), revokeReason: 'email_delivery_failed' } }
    );
    throw e;
  }

  return invitationBody(invitation);
}

async function listInvitationsAndMembers(userId, householdId) {
  const membership = await getMembership(userId, householdId);
  const hid = membership.householdId;
  await expirePendingInvites(hid);

  const db = getDb();
  const members = await db.collection('household_users')
    .find({ householdId: hid, status: 'ACTIVE' })
    .sort({ joinedAt: 1, _id: 1 })
    .toArray();
  const pending = await db.collection('household_invitations')
    .find({ householdId: hid, status: 'PENDING' })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  const acceptedBodies = [];
  for (const m of members) acceptedBodies.push(await acceptedMemberBody(m));
  return [...pending.map(invitationBody), ...acceptedBodies];
}

async function revokeInvitation(userId, householdId, invitationId) {
  const manager = await requireManager(userId, householdId);
  const id = asObjectId(invitationId, 'id');
  const db = getDb();
  const current = await db.collection('household_invitations').findOne({ _id: id, householdId: manager.householdId });
  if (!current) throw sharingError(404, 'not_found', 'That invitation no longer exists.');
  if (current.status === 'REVOKED') return { id: current._id.toHexString(), status: 'REVOKED' };
  if (current.status !== 'PENDING') throw sharingError(409, 'not_pending', 'That invitation is no longer pending.');

  await db.collection('household_invitations').updateOne(
    { _id: id, householdId: manager.householdId, status: 'PENDING' },
    { $set: { status: 'REVOKED', inviteCode: null, revokedAt: new Date(), updatedAt: new Date(), revokedBy: userId } }
  );
  return { id: current._id.toHexString(), status: 'REVOKED' };
}

async function countOwners(hid) {
  return getDb().collection('household_users').countDocuments({
    householdId: hid,
    status: 'ACTIVE',
    $or: [
      { sharingRole: 'OWNER' },
      { role: 'HOUSEHOLD_ADMIN', $or: [{ sharingRole: { $exists: false } }, { sharingRole: null }] }
    ]
  });
}

async function changeRole(userId, householdId, targetId, body) {
  const manager = await requireManager(userId, householdId);
  const hid = manager.householdId;
  const id = asObjectId(targetId, 'id');
  const role = normalizeRole(body?.role);
  const db = getDb();

  // Pending invitation role change.
  const invitation = await db.collection('household_invitations').findOne({ _id: id, householdId: hid });
  if (invitation) {
    if (invitation.status !== 'PENDING') throw sharingError(409, 'not_pending', 'That invitation is no longer pending.');
    const updated = await db.collection('household_invitations').findOneAndUpdate(
      { _id: id, householdId: hid, status: 'PENDING' },
      { $set: { role, internalRole: internalRole(role), updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    return invitationBody(updated);
  }

  // Accepted member role change.
  const target = await db.collection('household_users').findOne({ _id: id, householdId: hid, status: 'ACTIVE' });
  if (!target) throw sharingError(404, 'not_found', 'That household member no longer exists.');

  const oldWire = wireRole(target);
  if (oldWire === 'OWNER' && role !== 'OWNER') {
    const owners = await countOwners(hid);
    if (owners <= 1) throw sharingError(409, 'last_owner', 'A household must keep at least one owner.');
  }

  const updated = await db.collection('household_users').findOneAndUpdate(
    { _id: id, householdId: hid, status: 'ACTIVE' },
    { $set: { role: internalRole(role), sharingRole: role, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  return acceptedMemberBody(updated);
}

async function redeemRateCheck(userId, ip) {
  const db = getDb();
  const now = new Date();
  const keys = [`user:${userId.toHexString()}`, `ip:${ip || 'unknown'}`];
  for (const key of keys) {
    const row = await db.collection('invite_redeem_rate_limits').findOne({ key });
    if (row && row.expiresAt > now && row.count >= REDEEM_MAX_ATTEMPTS) {
      throw sharingError(429, 'rate_limited', 'Too many invite-code attempts. Please try again later.');
    }
  }
}

async function redeemRateFail(userId, ip) {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REDEEM_WINDOW_MS);
  for (const key of [`user:${userId.toHexString()}`, `ip:${ip || 'unknown'}`]) {
    const current = await db.collection('invite_redeem_rate_limits').findOne({ key });
    if (!current || current.expiresAt <= now) {
      await db.collection('invite_redeem_rate_limits').updateOne(
        { key }, { $set: { key, count: 1, expiresAt, updatedAt: now } }, { upsert: true }
      );
    } else {
      await db.collection('invite_redeem_rate_limits').updateOne(
        { key }, { $inc: { count: 1 }, $set: { updatedAt: now } }
      );
    }
  }
}

async function redeemRateClear(userId) {
  await getDb().collection('invite_redeem_rate_limits').deleteOne({ key: `user:${userId.toHexString()}` });
}

async function redeemInvitation(userId, body, ip) {
  const code = String(body?.code || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) {
    await redeemRateFail(userId, ip);
    throw sharingError(404, 'invalid_code', 'That code is no longer valid.');
  }
  await redeemRateCheck(userId, ip);

  const db = getDb();
  const client = getClient();
  let invitation = await db.collection('household_invitations').findOne({ inviteCode: code });
  if (!invitation) {
    await redeemRateFail(userId, ip);
    throw sharingError(404, 'invalid_code', 'That code is no longer valid.');
  }
  if (invitation.status !== 'PENDING') {
    await redeemRateFail(userId, ip);
    throw sharingError(invitation.status === 'EXPIRED' ? 410 : 404, 'invalid_code', 'That code is no longer valid.');
  }
  if (invitation.expiresAt && invitation.expiresAt <= new Date()) {
    await db.collection('household_invitations').updateOne(
      { _id: invitation._id, status: 'PENDING' },
      { $set: { status: 'EXPIRED', inviteCode: null, updatedAt: new Date() } }
    );
    await redeemRateFail(userId, ip);
    throw sharingError(410, 'invalid_code', 'That code is no longer valid.');
  }

  const user = await db.collection('users').findOne({ _id: userId, status: { $ne: 'DELETED' } });
  if (!user || String(user.primaryEmail || '').toLowerCase() !== invitation.email) {
    await redeemRateFail(userId, ip);
    // Same invalid-code response: do not reveal which account/email was invited.
    throw sharingError(404, 'invalid_code', 'That code is no longer valid.');
  }

  const session = client.startSession();
  let resultBody;
  try {
    await session.withTransaction(async () => {
      // Lock-by-condition: only a still-pending, still-unburned code can redeem.
      invitation = await db.collection('household_invitations').findOne(
        { _id: invitation._id, inviteCode: code, status: 'PENDING' }, { session }
      );
      if (!invitation) throw sharingError(404, 'invalid_code', 'That code is no longer valid.');

      let membership = await db.collection('household_users').findOne(
        { householdId: invitation.householdId, userId, status: 'ACTIVE' }, { session }
      );

      let familyMemberId = membership?.familyMemberId || null;
      if (!membership) {
        if (invitation.familyMemberIdRaw && /^[a-fA-F0-9]{24}$/.test(invitation.familyMemberIdRaw)) {
          const candidate = new ObjectId(invitation.familyMemberIdRaw);
          const fm = await db.collection('family_members').findOne(
            { _id: candidate, householdId: invitation.householdId, isDeleted: { $ne: true } }, { session }
          );
          if (fm && (!fm.linkedUserId || fm.linkedUserId.equals(userId))) {
            familyMemberId = candidate;
            await db.collection('family_members').updateOne(
              { _id: candidate, householdId: invitation.householdId },
              { $set: { linkedUserId: userId, updatedAt: new Date(), updatedBy: userId }, $inc: { version: 1 } },
              { session }
            );
          }
        }

        if (!familyMemberId) {
          const household = await db.collection('households').findOne({ _id: invitation.householdId }, { session });
          const now = new Date();
          const member = {
            householdId: invitation.householdId,
            linkedUserId: userId,
            name: invitation.displayName || user.preferredName || user.primaryEmail.split('@')[0],
            relationship: 'OTHER',
            financialRole: 'CONTRIBUTOR',
            status: 'ACTIVE', version: 1, isDeleted: false,
            visibility: 'HOUSEHOLD', source: 'SYSTEM', currency: household?.baseCurrency || 'INR',
            createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId
          };
          const mr = await db.collection('family_members').insertOne(member, { session });
          familyMemberId = mr.insertedId;
        }

        const membershipDoc = {
          householdId: invitation.householdId,
          userId,
          familyMemberId,
          role: invitation.internalRole || internalRole(invitation.role),
          sharingRole: invitation.role,
          status: 'ACTIVE',
          joinedAt: new Date(),
          updatedAt: new Date()
        };
        const mres = await db.collection('household_users').insertOne(membershipDoc, { session });
        membershipDoc._id = mres.insertedId;
        membership = membershipDoc;
      }

      const acceptedAt = new Date();
      const burn = await db.collection('household_invitations').updateOne(
        { _id: invitation._id, inviteCode: code, status: 'PENDING' },
        { $set: {
          status: 'ACCEPTED', inviteCode: null, acceptedBy: userId, acceptedAt,
          membershipId: membership._id, updatedAt: acceptedAt
        } },
        { session }
      );
      if (burn.modifiedCount !== 1) throw sharingError(404, 'invalid_code', 'That code is no longer valid.');

      const memberBody = await acceptedMemberBody({ ...membership, householdId: invitation.householdId });
      resultBody = {
        householdId: invitation.householdId.toHexString(),
        ...memberBody
      };
    });
  } finally {
    await session.endSession();
  }

  await redeemRateClear(userId);
  return resultBody;
}

function sendSharingError(res, err) {
  // Family-sharing Flutter code expects the compact { error: { ... } } shape.
  // Reformat both sharing-specific ApiErrors and standard membership/validation
  // ApiErrors without exposing driver details.
  if (err?.status && err?.code && typeof err.code === 'string') {
    const body = { error: { code: err.code, message: err.message } };
    if (err.field) body.error.field = err.field;
    return res.status(err.status).json(body);
  }
  throw err;
}

module.exports = {
  createInvitation,
  listInvitationsAndMembers,
  revokeInvitation,
  changeRole,
  redeemInvitation,
  sendSharingError,
  wireRole
};
