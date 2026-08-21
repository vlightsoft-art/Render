/**
 * FamFin Family Sharing DB Setup
 *
 * ONE-TIME / IDEMPOTENT SETUP
 *
 * Creates or repairs:
 *   1. household_invitations
 *   2. invite_redeem_rate_limits
 *
 * Also:
 *   - applies validators that match the current Family Sharing API
 *   - repairs/replaces older conflicting indexes
 *   - creates the exact indexes expected by the unified API
 *   - verifies the final setup
 *
 * Run:
 *   npm install mongodb dotenv
 *   node setup-sharing-db.js
 *
 * .env:
 *   MONGODB_URI=mongodb+srv://...
 *   MONGODB_DB=family_finance
 */

require("dotenv").config();

const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "family_finance";

if (!MONGODB_URI) {
  console.error("ERROR: MONGODB_URI is missing from .env");
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Validators                                                                 */
/* -------------------------------------------------------------------------- */

const invitationValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "householdId",
      "email",
      "role",
      "internalRole",
      "status",
      "inviteCode",
      "createdBy",
      "createdAt",
      "updatedAt",
      "expiresAt"
    ],
    properties: {
      householdId: {
        bsonType: "objectId"
      },

      email: {
        bsonType: "string"
      },

      role: {
        bsonType: "string"
      },

      internalRole: {
        bsonType: "string"
      },

      status: {
        enum: [
          "PENDING",
          "ACCEPTED",
          "REVOKED",
          "EXPIRED"
        ]
      },

      displayName: {
        bsonType: ["string", "null"]
      },

      /*
       * The Flutter wire contract may send an opaque family-member id.
       * The current API deliberately stores it as the raw string and only
       * converts it to ObjectId when it is a valid 24-char cloud ObjectId.
       */
      familyMemberIdRaw: {
        bsonType: ["string", "null"]
      },

      /*
       * inviteCode becomes null immediately after ACCEPTED / REVOKED / EXPIRED
       * so a burned code can never be redeemed again.
       */
      inviteCode: {
        bsonType: ["string", "null"]
      },

      createdBy: {
        bsonType: "objectId"
      },

      createdAt: {
        bsonType: "date"
      },

      updatedAt: {
        bsonType: "date"
      },

      expiresAt: {
        bsonType: "date"
      },

      acceptedBy: {
        bsonType: ["objectId", "null"]
      },

      acceptedAt: {
        bsonType: ["date", "null"]
      },

      revokedAt: {
        bsonType: ["date", "null"]
      },

      revokedBy: {
        bsonType: ["objectId", "null"]
      },

      membershipId: {
        bsonType: ["objectId", "null"]
      },

      revokeReason: {
        bsonType: ["string", "null"]
      }
    }
  }
};

const redeemRateLimitValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "key",
      "count",
      "expiresAt",
      "updatedAt"
    ],
    properties: {
      key: {
        bsonType: "string"
      },

      count: {
        bsonType: ["int", "long"],
        minimum: 0
      },

      expiresAt: {
        bsonType: "date"
      },

      updatedAt: {
        bsonType: "date"
      }
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Exact indexes expected by the current unified Family Sharing API           */
/* -------------------------------------------------------------------------- */

const INVITATION_INDEXES = [
  {
    name: "uniq_invite_code",
    key: { inviteCode: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        inviteCode: { $type: "string" }
      }
    }
  },
  {
    name: "by_household_status",
    key: {
      householdId: 1,
      status: 1,
      createdAt: -1
    },
    options: {}
  },
  {
    name: "by_household_email_status",
    key: {
      householdId: 1,
      email: 1,
      status: 1
    },
    options: {}
  },
  {
    name: "by_expiry_status",
    key: {
      expiresAt: 1,
      status: 1
    },
    options: {}
  }
];

const RATE_LIMIT_INDEXES = [
  {
    name: "uniq_key",
    key: { key: 1 },
    options: {
      unique: true
    }
  },
  {
    name: "ttl_expires",
    key: { expiresAt: 1 },
    options: {
      expireAfterSeconds: 0
    }
  }
];

/*
 * Earlier manual setup used these names.
 * They are not expected by the current unified API.
 */
const LEGACY_INVITATION_INDEX_NAMES = [
  "uniq_inviteCode",
  "by_email_status",
  "by_expiresAt"
];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function sameKey(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

function samePartial(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function indexMatches(existing, expected) {
  if (!sameKey(existing.key, expected.key)) {
    return false;
  }

  if (Boolean(existing.unique) !== Boolean(expected.options.unique)) {
    return false;
  }

  if (
    (existing.expireAfterSeconds ?? null) !==
    (expected.options.expireAfterSeconds ?? null)
  ) {
    return false;
  }

  if (
    !samePartial(
      existing.partialFilterExpression,
      expected.options.partialFilterExpression
    )
  ) {
    return false;
  }

  return true;
}

async function collectionExists(db, name) {
  return db
    .listCollections({ name }, { nameOnly: true })
    .hasNext();
}

async function ensureCollection(db, name, validator) {
  const exists = await collectionExists(db, name);

  if (!exists) {
    await db.createCollection(name, {
      validator,
      validationLevel: "strict",
      validationAction: "error"
    });

    console.log(`+ Created collection: ${name}`);
    return;
  }

  /*
   * Important: this also repairs the earlier manually-added validator so it
   * matches what the actual Family Sharing API writes.
   */
  await db.command({
    collMod: name,
    validator,
    validationLevel: "strict",
    validationAction: "error"
  });

  console.log(`= Updated validator: ${name}`);
}

async function dropIndexIfExists(collection, name) {
  const indexes = await collection.indexes();
  const exists = indexes.some(index => index.name === name);

  if (exists) {
    await collection.dropIndex(name);
    console.log(`- Dropped old index: ${collection.collectionName}.${name}`);
  }
}

async function ensureExactIndex(collection, expected) {
  let indexes = await collection.indexes();

  const current = indexes.find(
    index => index.name === expected.name
  );

  if (current && indexMatches(current, expected)) {
    console.log(
      `= Index already correct: ${collection.collectionName}.${expected.name}`
    );
    return;
  }

  if (current) {
    await collection.dropIndex(expected.name);

    console.log(
      `- Replacing mismatched index: ${collection.collectionName}.${expected.name}`
    );
  }

  await collection.createIndex(
    expected.key,
    {
      name: expected.name,
      ...expected.options
    }
  );

  console.log(
    `+ Created index: ${collection.collectionName}.${expected.name}`
  );
}

async function verifyCollection(db, name, expectedIndexes) {
  const info = await db
    .listCollections({ name }, { nameOnly: false })
    .next();

  if (!info) {
    throw new Error(`Verification failed: ${name} does not exist.`);
  }

  const validator =
    info.options &&
    info.options.validator;

  if (
    !validator ||
    Object.keys(validator).length === 0
  ) {
    throw new Error(
      `Verification failed: ${name} has no validator.`
    );
  }

  const indexes = await db
    .collection(name)
    .indexes();

  for (const expected of expectedIndexes) {
    const actual = indexes.find(
      index => index.name === expected.name
    );

    if (!actual) {
      throw new Error(
        `Verification failed: missing index ${name}.${expected.name}`
      );
    }

    if (!indexMatches(actual, expected)) {
      throw new Error(
        `Verification failed: incorrect index ${name}.${expected.name}`
      );
    }
  }

  console.log(`✓ Verified: ${name}`);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const client = new MongoClient(
    MONGODB_URI,
    {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000
    }
  );

  try {
    console.log("");
    console.log("============================================================");
    console.log("FAMFIN FAMILY SHARING DATABASE SETUP");
    console.log("============================================================");
    console.log(`Database: ${DB_NAME}`);
    console.log("");

    await client.connect();

    const db = client.db(DB_NAME);

    await db.command({ ping: 1 });

    console.log("✓ Connected to MongoDB Atlas");
    console.log("");

    /* ---------------------------------------------------------------------- */
    /* household_invitations                                                  */
    /* ---------------------------------------------------------------------- */

    console.log("1. household_invitations");
    console.log("------------------------");

    await ensureCollection(
      db,
      "household_invitations",
      invitationValidator
    );

    const invitations =
      db.collection("household_invitations");

    /*
     * Remove legacy manual indexes before applying the exact API indexes.
     */
    for (const legacyName of LEGACY_INVITATION_INDEX_NAMES) {
      await dropIndexIfExists(
        invitations,
        legacyName
      );
    }

    for (const index of INVITATION_INDEXES) {
      await ensureExactIndex(
        invitations,
        index
      );
    }

    console.log("");

    /* ---------------------------------------------------------------------- */
    /* invite_redeem_rate_limits                                              */
    /* ---------------------------------------------------------------------- */

    console.log("2. invite_redeem_rate_limits");
    console.log("----------------------------");

    await ensureCollection(
      db,
      "invite_redeem_rate_limits",
      redeemRateLimitValidator
    );

    const rateLimits =
      db.collection("invite_redeem_rate_limits");

    for (const index of RATE_LIMIT_INDEXES) {
      await ensureExactIndex(
        rateLimits,
        index
      );
    }

    console.log("");

    /* ---------------------------------------------------------------------- */
    /* Verify                                                                 */
    /* ---------------------------------------------------------------------- */

    console.log("3. Verification");
    console.log("---------------");

    await verifyCollection(
      db,
      "household_invitations",
      INVITATION_INDEXES
    );

    await verifyCollection(
      db,
      "invite_redeem_rate_limits",
      RATE_LIMIT_INDEXES
    );

    console.log("");
    console.log("Final household_invitations indexes:");

    const finalInvitationIndexes =
      await invitations.indexes();

    for (const index of finalInvitationIndexes) {
      console.log(
        `  - ${index.name}`,
        index.key
      );
    }

    console.log("");
    console.log("Final invite_redeem_rate_limits indexes:");

    const finalRateIndexes =
      await rateLimits.indexes();

    for (const index of finalRateIndexes) {
      console.log(
        `  - ${index.name}`,
        index.key,
        index.expireAfterSeconds !== undefined
          ? `(TTL ${index.expireAfterSeconds}s)`
          : ""
      );
    }

    console.log("");
    console.log("============================================================");
    console.log("✓ FAMILY SHARING DATABASE SETUP COMPLETE");
    console.log("============================================================");
    console.log("");
    console.log("Collections configured:");
    console.log("  ✓ household_invitations");
    console.log("  ✓ invite_redeem_rate_limits");
    console.log("");
    console.log("You can safely run this script again.");
    console.log("");
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error("");
  console.error("FAMILY SHARING DATABASE SETUP FAILED");
  console.error("------------------------------------");
  console.error(error);

  process.exit(1);
});
