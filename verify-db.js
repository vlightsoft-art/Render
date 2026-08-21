/**
 * FamFin MongoDB Atlas verifier
 * Database: family_finance
 * Expected schema version: 1
 *
 * This verifier is designed to match the FamFin init-db.js initializer.
 *
 * It checks:
 *   - MongoDB connectivity
 *   - 67 expected application collections
 *   - Validators present
 *   - Important named indexes
 *   - 5 seeded system roles
 *   - 72 seeded permissions
 *   - 11 seeded top-level system expense categories
 *   - database_schema_version = 1
 *
 * Exit code:
 *   0 = verification passed
 *   1 = verification failed
 *
 * Required packages:
 *   npm install mongodb dotenv
 *
 * Required .env:
 *   MONGODB_URI=mongodb+srv://...
 *   MONGODB_DB=family_finance
 */

require("dotenv").config();

const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "family_finance";
const EXPECTED_SCHEMA_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Expected collections                                                       */
/* -------------------------------------------------------------------------- */

const EXPECTED_COLLECTIONS = [
  // 1. Identity
  "users",
  "user_identities",
  "user_preferences",

  // 2. Household & access
  "households",
  "household_users",
  "family_members",
  "roles",
  "permissions",
  "role_permissions",
  "record_shares",

  // 3. Income
  "income_sources",
  "salary_structures",
  "salary_components",
  "income_events",

  // 4. Employer benefits
  "employer_benefits",
  "benefit_claims",

  // 5. Accounts & transactions
  "accounts",
  "transactions",

  // 6. Expenses & bills
  "expense_categories",
  "expenses",
  "expense_rules",
  "bill_definitions",
  "bill_instances",

  // 7. Budgets & allocation
  "budgets",
  "budget_periods",
  "budget_buckets",
  "budget_rules",
  "allocation_plans",
  "allocation_items",

  // 8. Debt
  "loans",
  "loan_payments",
  "credit_cards",

  // 9. Wealth
  "investments",
  "investment_transactions",
  "investment_closures",
  "assets",
  "liabilities",

  // 10. Goals & protection
  "goals",
  "goal_contributions",
  "emergency_fund_plans",
  "insurance_policies",

  // 11. Periods & snapshots
  "financial_periods",
  "financial_snapshots",
  "household_financial_summary",

  // 12. Audit & activity
  "audit_findings",
  "audit_runs",
  "audit_logs",
  "activity_logs",

  // 13. Notifications
  "notifications",
  "notification_preferences",

  // 14. Documents
  "documents",
  "document_extraction_results",
  "document_corrections",

  // 15. AI
  "ai_conversations",
  "ai_messages",
  "ai_action_proposals",

  // 16. Search
  "search_documents",
  "recent_searches",
  "recently_viewed",

  // 17. Journal & planning
  "decision_journal_entries",
  "life_events",

  // 18. Commerce
  "subscriptions",
  "entitlements",

  // 19. Platform
  "domain_events",
  "background_jobs",
  "data_export_jobs",
  "database_schema_version"
];

/* -------------------------------------------------------------------------- */
/* Expected roles                                                             */
/* -------------------------------------------------------------------------- */

const EXPECTED_ROLES = [
  "HOUSEHOLD_ADMIN",
  "FINANCIAL_PARTNER",
  "MEMBER",
  "VIEW_ONLY",
  "GOAL_CONTRIBUTOR"
];

/* -------------------------------------------------------------------------- */
/* Expected permission model                                                  */
/* -------------------------------------------------------------------------- */

const PERMISSION_ENTITIES = [
  "household",
  "family",
  "income",
  "salary",
  "benefit",
  "expense",
  "bill",
  "account",
  "transaction",
  "budget",
  "loan",
  "card",
  "investment",
  "goal",
  "insurance",
  "document",
  "audit",
  "export"
];

const PERMISSION_ACTIONS = [
  "read",
  "create",
  "update",
  "delete"
];

const EXPECTED_PERMISSION_COUNT =
  PERMISSION_ENTITIES.length * PERMISSION_ACTIONS.length;

/* -------------------------------------------------------------------------- */
/* Expected top-level expense category groups                                 */
/* -------------------------------------------------------------------------- */

const EXPECTED_EXPENSE_GROUPS = [
  "HOUSING",
  "UTILITIES",
  "FOOD",
  "TRANSPORT",
  "FAMILY",
  "HEALTH",
  "LIFESTYLE",
  "FINANCIAL",
  "SUBSCRIPTIONS",
  "EDUCATION",
  "OTHER"
];

/* -------------------------------------------------------------------------- */
/* Important named indexes from init-db.js                                    */
/* -------------------------------------------------------------------------- */

const IMPORTANT_INDEXES = {
  users: [
    "uniq_authUserId",
    "uniq_primaryEmail"
  ],

  user_identities: [
    "uniq_provider_subject",
    "by_user"
  ],

  user_preferences: [
    "uniq_user"
  ],

  household_users: [
    "uniq_household_user",
    "by_user_status"
  ],

  family_members: [
    "by_household_status"
  ],

  roles: [
    "uniq_role_code"
  ],

  permissions: [
    "uniq_permission_code",
    "by_entity_action"
  ],

  role_permissions: [
    "uniq_role_permission"
  ],

  accounts: [
    "by_household_status"
  ],

  transactions: [
    "by_date",
    "by_account_date",
    "by_import_ref"
  ],

  expenses: [
    "by_date",
    "by_category_date",
    "by_payer_date"
  ],

  expense_rules: [
    "by_household_priority",
    "by_match"
  ],

  bill_instances: [
    "uniq_definition_period",
    "by_due_status"
  ],

  loans: [
    "by_household_status"
  ],

  loan_payments: [
    "by_loan_date",
    "by_household_date"
  ],

  investments: [
    "by_owner_status"
  ],

  investment_closures: [
    "by_investment",
    "by_match_status"
  ],

  emergency_fund_plans: [
    "uniq_household"
  ],

  audit_findings: [
    "by_status_detected",
    "by_category_period",
    "uniq_dedupe"
  ],

  notifications: [
    "by_user_unread",
    "uniq_user_dedupe"
  ],

  documents: [
    "by_type_uploaded"
  ],

  document_corrections: [
    "by_document_field"
  ],

  ai_action_proposals: [
    "by_household_status",
    "ttl_expires"
  ],

  search_documents: [
    "uniq_entity",
    "text_search",
    "by_date"
  ],

  entitlements: [
    "uniq_household_feature"
  ],

  domain_events: [
    "by_status_occurred",
    "uniq_event"
  ],

  data_export_jobs: [
    "by_user_requested",
    "ttl_expires"
  ],

  database_schema_version: [
    "uniq_version"
  ]
};

/* -------------------------------------------------------------------------- */
/* Output helpers                                                             */
/* -------------------------------------------------------------------------- */

let failures = 0;
let warnings = 0;
let checksPassed = 0;

function section(title) {
  console.log("");
  console.log("=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

function ok(message) {
  checksPassed++;
  console.log(`✓ ${message}`);
}

function fail(message) {
  failures++;
  console.error(`✗ ${message}`);
}

function warn(message) {
  warnings++;
  console.warn(`⚠ ${message}`);
}

/* -------------------------------------------------------------------------- */
/* Verification functions                                                     */
/* -------------------------------------------------------------------------- */

async function verifyConnection(db) {
  section("1. MONGODB CONNECTION");

  await db.command({ ping: 1 });

  ok("MongoDB ping successful");
  ok(`Database selected: ${DB_NAME}`);
}

async function getCollectionMetadata(db) {
  return db
    .listCollections({}, { nameOnly: false })
    .toArray();
}

async function verifyCollections(collectionMetadata) {
  section("2. COLLECTIONS");

  const existingNames = new Set(
    collectionMetadata.map((item) => item.name)
  );

  let found = 0;

  for (const name of EXPECTED_COLLECTIONS) {
    if (existingNames.has(name)) {
      found++;
      ok(name);
    } else {
      fail(`Missing collection: ${name}`);
    }
  }

  console.log("");
  console.log(`Expected collections : ${EXPECTED_COLLECTIONS.length}`);
  console.log(`Found collections    : ${found}`);

  if (found === EXPECTED_COLLECTIONS.length) {
    ok("All expected FamFin collections are present");
  }

  return existingNames;
}

async function verifyValidators(collectionMetadata) {
  section("3. JSON SCHEMA VALIDATORS");

  const metadataByName = new Map(
    collectionMetadata.map((item) => [item.name, item])
  );

  let validatorCount = 0;

  for (const name of EXPECTED_COLLECTIONS) {
    const info = metadataByName.get(name);

    if (!info) {
      continue;
    }

    const validator =
      info.options &&
      info.options.validator;

    if (
      validator &&
      typeof validator === "object" &&
      Object.keys(validator).length > 0
    ) {
      validatorCount++;
      ok(`${name}: validator present`);
    } else {
      fail(`${name}: validator missing`);
    }
  }

  console.log("");
  console.log(
    `Validators present: ${validatorCount}/${EXPECTED_COLLECTIONS.length}`
  );
}

async function verifyIndexes(db, existingNames) {
  section("4. IMPORTANT INDEXES");

  for (const [collectionName, requiredIndexNames] of Object.entries(
    IMPORTANT_INDEXES
  )) {
    if (!existingNames.has(collectionName)) {
      fail(
        `${collectionName}: cannot verify indexes because collection is missing`
      );
      continue;
    }

    let indexes;

    try {
      indexes = await db
        .collection(collectionName)
        .indexes();
    } catch (error) {
      fail(
        `${collectionName}: unable to read indexes: ${error.message}`
      );
      continue;
    }

    const actualIndexNames = new Set(
      indexes.map((index) => index.name)
    );

    for (const indexName of requiredIndexNames) {
      if (actualIndexNames.has(indexName)) {
        ok(`${collectionName}.${indexName}`);
      } else {
        fail(
          `Missing index: ${collectionName}.${indexName}`
        );
      }
    }
  }
}

async function verifyRoles(db, existingNames) {
  section("5. SYSTEM ROLES");

  if (!existingNames.has("roles")) {
    fail("roles collection does not exist");
    return;
  }

  const rows = await db
    .collection("roles")
    .find({
      code: {
        $in: EXPECTED_ROLES
      }
    })
    .project({
      _id: 0,
      code: 1
    })
    .toArray();

  const found = new Set(
    rows.map((row) => row.code)
  );

  for (const role of EXPECTED_ROLES) {
    if (found.has(role)) {
      ok(`Role seeded: ${role}`);
    } else {
      fail(`Missing seeded role: ${role}`);
    }
  }
}

async function verifyPermissions(db, existingNames) {
  section("6. PERMISSIONS");

  if (!existingNames.has("permissions")) {
    fail("permissions collection does not exist");
    return;
  }

  const permissions = await db
    .collection("permissions")
    .find({})
    .project({
      _id: 0,
      code: 1,
      entity: 1,
      action: 1
    })
    .toArray();

  console.log(
    `Permission records found: ${permissions.length}`
  );

  if (permissions.length === EXPECTED_PERMISSION_COUNT) {
    ok(
      `Permission count is exactly ${EXPECTED_PERMISSION_COUNT}`
    );
  } else {
    fail(
      `Expected ${EXPECTED_PERMISSION_COUNT} permissions, found ${permissions.length}`
    );
  }

  const codeSet = new Set(
    permissions.map((permission) => permission.code)
  );

  for (const entity of PERMISSION_ENTITIES) {
    for (const action of PERMISSION_ACTIONS) {
      const code = `${entity}.${action}`;

      if (!codeSet.has(code)) {
        fail(`Missing permission: ${code}`);
      }
    }
  }

  if (failures === 0) {
    ok("All expected permission codes are present");
  }
}

async function verifyExpenseCategorySeeds(
  db,
  existingNames
) {
  section("7. SYSTEM EXPENSE CATEGORIES");

  if (!existingNames.has("expense_categories")) {
    fail("expense_categories collection does not exist");
    return;
  }

  const categories = await db
    .collection("expense_categories")
    .find({
      householdId: null,
      systemCategory: true,
      parentCategoryId: null
    })
    .project({
      _id: 0,
      categoryGroup: 1,
      name: 1
    })
    .toArray();

  const groupSet = new Set(
    categories.map((category) => category.categoryGroup)
  );

  for (const group of EXPECTED_EXPENSE_GROUPS) {
    if (groupSet.has(group)) {
      ok(`System category group: ${group}`);
    } else {
      fail(`Missing system expense group: ${group}`);
    }
  }

  console.log("");
  console.log(
    `Expected top-level system groups: ${EXPECTED_EXPENSE_GROUPS.length}`
  );
  console.log(
    `Found top-level system groups   : ${categories.length}`
  );
}

async function verifySchemaVersion(
  db,
  existingNames
) {
  section("8. SCHEMA VERSION");

  if (!existingNames.has("database_schema_version")) {
    fail("database_schema_version collection is missing");
    return;
  }

  const latest = await db
    .collection("database_schema_version")
    .find({})
    .sort({
      version: -1
    })
    .limit(1)
    .next();

  if (!latest) {
    fail("No schema version record found");
    return;
  }

  console.log(`Latest version: ${latest.version}`);

  if (latest.version === EXPECTED_SCHEMA_VERSION) {
    ok(
      `Schema version is ${EXPECTED_SCHEMA_VERSION}`
    );
  } else {
    fail(
      `Expected schema version ${EXPECTED_SCHEMA_VERSION}, found ${latest.version}`
    );
  }
}

async function verifyDecimal128Validation(
  db,
  collectionMetadata
) {
  section("9. MONEY / DECIMAL128 VALIDATION");

  /*
   * This verifies the validator definitions on a sample of critical
   * financial collections. It does not insert test data.
   */

  const criticalMoneyCollections = [
    "accounts",
    "transactions",
    "expenses",
    "loans",
    "loan_payments",
    "credit_cards",
    "investments",
    "investment_transactions",
    "investment_closures",
    "goals",
    "insurance_policies",
    "financial_snapshots"
  ];

  const metadataByName = new Map(
    collectionMetadata.map((item) => [item.name, item])
  );

  let checked = 0;

  for (const name of criticalMoneyCollections) {
    const info = metadataByName.get(name);

    if (!info) {
      fail(
        `${name}: cannot inspect money validator because collection is missing`
      );
      continue;
    }

    const jsonSchema =
      info.options &&
      info.options.validator &&
      info.options.validator.$jsonSchema;

    if (!jsonSchema) {
      fail(`${name}: $jsonSchema validator missing`);
      continue;
    }

    /*
     * We only confirm that at least one property in this critical financial
     * collection is declared as BSON decimal.
     */
    const properties = jsonSchema.properties || {};

    const hasDecimal = Object.values(properties).some(
      (property) =>
        property &&
        property.bsonType === "decimal"
    );

    if (hasDecimal) {
      checked++;
      ok(`${name}: Decimal128 field validation present`);
    } else {
      warn(
        `${name}: no top-level Decimal128 field found in validator`
      );
    }
  }

  console.log("");
  console.log(
    `Critical money collections with Decimal128 validation: ${checked}/${criticalMoneyCollections.length}`
  );
}

async function verifyTTLIndexes(db, existingNames) {
  section("10. TTL INDEXES");

  const expectedTTL = [
    ["ai_action_proposals", "ttl_expires"],
    ["data_export_jobs", "ttl_expires"]
  ];

  for (const [collectionName, indexName] of expectedTTL) {
    if (!existingNames.has(collectionName)) {
      fail(
        `${collectionName}: collection missing`
      );
      continue;
    }

    const indexes = await db
      .collection(collectionName)
      .indexes();

    const ttl = indexes.find(
      (index) => index.name === indexName
    );

    if (!ttl) {
      fail(
        `${collectionName}.${indexName}: TTL index missing`
      );
      continue;
    }

    if (ttl.expireAfterSeconds === 0) {
      ok(
        `${collectionName}.${indexName}: TTL configured correctly`
      );
    } else {
      fail(
        `${collectionName}.${indexName}: expected expireAfterSeconds=0`
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log("");
  console.log("============================================================");
  console.log("FAMFIN MONGODB VERIFIER");
  console.log("============================================================");
  console.log(`Database: ${DB_NAME}`);
  console.log(`Expected schema version: ${EXPECTED_SCHEMA_VERSION}`);
  console.log(`Expected collections: ${EXPECTED_COLLECTIONS.length}`);
  console.log("");

  if (!MONGODB_URI) {
    console.error("ERROR: MONGODB_URI is missing.");
    console.error("");
    console.error("Create a .env file:");
    console.error("");
    console.error(
      "MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/"
    );
    console.error("MONGODB_DB=family_finance");
    process.exit(1);
  }

  const client = new MongoClient(
    MONGODB_URI,
    {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000
    }
  );

  try {
    await client.connect();

    const db = client.db(DB_NAME);

    await verifyConnection(db);

    const collectionMetadata =
      await getCollectionMetadata(db);

    const existingNames =
      await verifyCollections(collectionMetadata);

    await verifyValidators(collectionMetadata);

    await verifyIndexes(
      db,
      existingNames
    );

    await verifyRoles(
      db,
      existingNames
    );

    await verifyPermissions(
      db,
      existingNames
    );

    await verifyExpenseCategorySeeds(
      db,
      existingNames
    );

    await verifySchemaVersion(
      db,
      existingNames
    );

    await verifyDecimal128Validation(
      db,
      collectionMetadata
    );

    await verifyTTLIndexes(
      db,
      existingNames
    );

    section("FINAL RESULT");

    console.log(`Checks passed : ${checksPassed}`);
    console.log(`Warnings      : ${warnings}`);
    console.log(`Failures      : ${failures}`);
    console.log("");

    if (failures === 0) {
      console.log("✓ DATABASE VERIFICATION PASSED");

      if (warnings > 0) {
        console.log(
          `  Passed with ${warnings} warning(s).`
        );
      }

      process.exitCode = 0;
    } else {
      console.error("✗ DATABASE VERIFICATION FAILED");
      console.error(
        `  Fix the ${failures} failure(s) above, then run again.`
      );

      process.exitCode = 1;
    }
  } catch (error) {
    console.error("");
    console.error("DATABASE VERIFICATION ERROR");
    console.error("---------------------------");
    console.error(error);

    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
    console.log("");
    console.log("MongoDB connection closed.");
  }
}

main();
