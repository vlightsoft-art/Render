/**
 * FamFin MongoDB Atlas initializer
 * Database: family_finance
 * Schema version: 1
 *
 * Single-file, idempotent setup based on the supplied FamFin schema.
 *
 * What it does:
 *   - Creates the 64 schema collections
 *   - Adds the 3 explicitly recommended missing collections:
 *       expense_rules, investment_closures, document_corrections
 *   - Applies MongoDB $jsonSchema validators
 *   - Creates named indexes
 *   - Seeds 5 system roles
 *   - Seeds 72 permissions (18 entities x 4 actions)
 *   - Seeds 11 top-level system expense category groups
 *   - Records database schema version 1
 *
 * Safe to run repeatedly.
 *
 * Required packages:
 *   npm install mongodb dotenv
 *
 * Required environment:
 *   MONGODB_URI=mongodb+srv://...
 *   MONGODB_DB=family_finance
 */

require("dotenv").config();

const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "family_finance";
const SCHEMA_VERSION = 1;

if (!MONGODB_URI) {
  console.error("ERROR: MONGODB_URI is missing.");
  console.error("Create a .env file with:");
  console.error("MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/");
  console.error("MONGODB_DB=family_finance");
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const OID = { bsonType: "objectId" };
const DATE = { bsonType: "date" };
const BOOL = { bsonType: "bool" };
const STR = { bsonType: "string" };
const INT = { bsonType: "int" };
const DOUBLE = { bsonType: "double" };
const DECIMAL = { bsonType: "decimal" };
const MONEY = DECIMAL;
const CAL = {
  bsonType: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "Calendar date in YYYY-MM-DD format"
};
const CURRENCY = {
  bsonType: "string",
  pattern: "^[A-Z]{3}$",
  description: "ISO 4217 currency code"
};
const OBJ = { bsonType: "object" };
const ARR = { bsonType: "array" };
const STR_ARR = { bsonType: "array", items: STR };
const OID_ARR = { bsonType: "array", items: OID };

const universalProperties = {
  householdId: OID,
  createdAt: DATE,
  updatedAt: DATE,
  createdBy: OID,
  updatedBy: OID,
  version: { bsonType: "int", minimum: 1 },
  status: STR,
  isDeleted: BOOL,
  deletedAt: DATE,
  ownerMemberId: OID,
  visibility: {
    enum: ["HOUSEHOLD", "PRIVATE", "SHARED_WITH_SELECTED", "ADMIN_ONLY"]
  },
  currency: CURRENCY,
  source: {
    enum: ["MANUAL", "IMPORT", "OCR", "AI", "SYSTEM"]
  },
  notes: STR
};

function validator(properties = {}, required = []) {
  return {
    $jsonSchema: {
      bsonType: "object",
      required,
      properties
    }
  };
}

function householdValidator(properties = {}, required = []) {
  return validator(
    { ...universalProperties, ...properties },
    [...new Set(["householdId", "createdAt", "updatedAt", "version", ...required])]
  );
}

function idx(name, key, options = {}) {
  return { name, key, options };
}

/* -------------------------------------------------------------------------- */
/* Collection definitions                                                     */
/* -------------------------------------------------------------------------- */

const collections = {
  /* 1. Identity ------------------------------------------------------------ */

  users: {
    validator: validator(
      {
        authUserId: STR,
        primaryEmail: STR,
        emailVerified: BOOL,
        preferredName: STR,
        status: { enum: ["PENDING", "ACTIVE", "SUSPENDED", "DELETED"] },
        createdAt: DATE,
        updatedAt: DATE,
        lastLoginAt: DATE
      },
      ["authUserId", "primaryEmail", "status", "createdAt"]
    ),
    indexes: [
      idx("uniq_authUserId", { authUserId: 1 }, { unique: true }),
      idx("uniq_primaryEmail", { primaryEmail: 1 }, { unique: true })
    ]
  },

  user_identities: {
    validator: validator(
      {
        userId: OID,
        provider: { enum: ["EMAIL", "GOOGLE", "APPLE", "PASSKEY"] },
        providerSubject: STR,
        providerEmail: STR,
        createdAt: DATE,
        lastUsedAt: DATE
      },
      ["userId", "provider", "providerSubject", "createdAt"]
    ),
    indexes: [
      idx(
        "uniq_provider_subject",
        { provider: 1, providerSubject: 1 },
        { unique: true }
      ),
      idx("by_user", { userId: 1 })
    ]
  },

  user_preferences: {
    validator: validator(
      {
        userId: OID,
        language: STR,
        locale: STR,
        aiLanguage: STR,
        timezone: STR,
        dateFormat: STR,
        numberFormat: { enum: ["INDIAN", "INTERNATIONAL"] },
        firstDayOfWeek: STR,
        theme: { enum: ["LIGHT", "DARK", "SYSTEM"] },
        accent: STR,
        displayDensity: STR,
        dashboardLayout: { bsonType: ["object", "array"] },
        updatedAt: DATE
      },
      ["userId"]
    ),
    indexes: [
      idx("uniq_user", { userId: 1 }, { unique: true })
    ]
  },

  /* 2. Household & access -------------------------------------------------- */

  households: {
    validator: validator(
      {
        name: STR,
        type: {
          enum: [
            "INDIVIDUAL",
            "COUPLE",
            "FAMILY",
            "JOINT_FAMILY",
            "SINGLE_PARENT",
            "OTHER"
          ]
        },
        country: STR,
        baseCurrency: CURRENCY,
        timezone: STR,
        financialMonthStartDay: {
          bsonType: "int",
          minimum: 1,
          maximum: 28
        },
        financialYearType: {
          enum: ["CALENDAR", "APRIL_MARCH", "JULY_JUNE", "CUSTOM"]
        },
        setupStatus: STR,
        createdBy: OID,
        version: { bsonType: "int", minimum: 1 },
        createdAt: DATE,
        updatedAt: DATE
      },
      ["name", "baseCurrency", "version", "createdAt", "updatedAt"]
    ),
    indexes: [
      idx("by_created", { createdAt: -1 })
    ]
  },

  household_users: {
    validator: validator(
      {
        householdId: OID,
        userId: OID,
        familyMemberId: OID,
        role: STR,
        status: { enum: ["INVITED", "ACTIVE", "SUSPENDED", "REMOVED"] },
        joinedAt: DATE,
        updatedAt: DATE
      },
      ["householdId", "userId", "role", "status"]
    ),
    indexes: [
      idx(
        "uniq_household_user",
        { householdId: 1, userId: 1 },
        { unique: true }
      ),
      idx("by_user_status", { userId: 1, status: 1 })
    ]
  },

  family_members: {
    validator: householdValidator(
      {
        linkedUserId: OID,
        name: STR,
        relationship: {
          enum: ["SELF", "SPOUSE", "CHILD", "PARENT", "SIBLING", "OTHER"]
        },
        dateOfBirth: CAL,
        employmentStatus: STR,
        financialRole: { enum: ["EARNER", "DEPENDENT", "CONTRIBUTOR"] },
        dependencyStatus: STR
      },
      ["name"]
    ),
    indexes: [
      idx("by_household_status", { householdId: 1, status: 1 })
    ]
  },

  roles: {
    validator: validator(
      {
        code: STR,
        name: STR,
        rank: INT,
        isSystem: BOOL
      },
      ["code", "name"]
    ),
    indexes: [
      idx("uniq_role_code", { code: 1 }, { unique: true })
    ]
  },

  permissions: {
    validator: validator(
      {
        code: STR,
        entity: STR,
        action: { enum: ["read", "create", "update", "delete"] }
      },
      ["code", "entity", "action"]
    ),
    indexes: [
      idx("uniq_permission_code", { code: 1 }, { unique: true }),
      idx("by_entity_action", { entity: 1, action: 1 })
    ]
  },

  role_permissions: {
    validator: validator(
      {
        roleCode: STR,
        permissionCode: STR
      },
      ["roleCode", "permissionCode"]
    ),
    indexes: [
      idx(
        "uniq_role_permission",
        { roleCode: 1, permissionCode: 1 },
        { unique: true }
      )
    ]
  },

  record_shares: {
    validator: householdValidator(
      {
        entityType: STR,
        entityId: OID,
        memberId: OID,
        accessLevel: { enum: ["VIEW", "EDIT"] },
        grantedBy: OID,
        grantedAt: DATE,
        expiresAt: DATE
      },
      ["entityType", "entityId", "memberId"]
    ),
    indexes: [
      idx("by_household_entity", { householdId: 1, entityType: 1, entityId: 1 }),
      idx("by_member", { householdId: 1, memberId: 1 })
    ]
  },

  /* 3. Income -------------------------------------------------------------- */

  income_sources: {
    validator: householdValidator(
      {
        type: {
          enum: [
            "SALARY",
            "BUSINESS",
            "FREELANCE",
            "RENTAL",
            "INTEREST",
            "DIVIDEND",
            "PENSION",
            "OTHER"
          ]
        },
        name: STR,
        employerName: STR,
        amount: MONEY,
        frequency: {
          enum: ["MONTHLY", "WEEKLY", "FORTNIGHTLY", "QUARTERLY", "ANNUAL", "IRREGULAR"]
        },
        expectedDateRule: OBJ,
        reliability: { enum: ["GUARANTEED", "LIKELY", "VARIABLE"] },
        confidence: { bsonType: "double", minimum: 0, maximum: 1 },
        startDate: CAL,
        endDate: CAL,
        isVariable: BOOL,
        includeInBudget: BOOL,
        isReimbursement: BOOL
      },
      ["name"]
    ),
    indexes: [
      idx("by_household_status", { householdId: 1, status: 1 }),
      idx("by_owner", { householdId: 1, ownerMemberId: 1 })
    ]
  },

  salary_structures: {
    validator: householdValidator(
      {
        employmentId: OID,
        effectiveFrom: CAL,
        effectiveTo: CAL,
        grossMonthly: MONEY,
        takeHomeMonthly: MONEY,
        mode: { enum: ["SIMPLE", "DETAILED"] }
      }
    ),
    indexes: [
      idx(
        "by_member_effective",
        { householdId: 1, ownerMemberId: 1, effectiveFrom: -1 }
      )
    ]
  },

  salary_components: {
    validator: householdValidator(
      {
        salaryStructureId: OID,
        componentType: {
          enum: ["EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION"]
        },
        name: STR,
        amount: MONEY,
        calculationType: { enum: ["FIXED", "PERCENTAGE", "FORMULA"] },
        percentageOf: STR,
        isTaxable: BOOL,
        isStatutory: BOOL,
        linkedBenefitId: OID,
        displayOrder: INT
      },
      ["salaryStructureId", "componentType", "name"]
    ),
    indexes: [
      idx("by_structure", { householdId: 1, salaryStructureId: 1, displayOrder: 1 })
    ]
  },

  income_events: {
    validator: householdValidator(
      {
        incomeSourceId: OID,
        memberId: OID,
        expectedAmount: MONEY,
        actualAmount: MONEY,
        expectedDate: CAL,
        receivedDate: CAL,
        accountId: OID,
        status: {
          enum: ["EXPECTED", "RECEIVED", "PARTIAL", "DELAYED", "MISSED", "CANCELLED"]
        },
        varianceReason: STR
      }
    ),
    indexes: [
      idx("by_expected_status", { householdId: 1, expectedDate: 1, status: 1 })
    ]
  },

  /* 4. Employer benefits --------------------------------------------------- */

  employer_benefits: {
    validator: householdValidator(
      {
        memberId: OID,
        employmentId: OID,
        name: STR,
        benefitType: STR,
        classification: {
          enum: [
            "CONTRIBUTION",
            "COVERAGE",
            "REIMBURSEMENT",
            "ALLOWANCE",
            "COMPANY_PROVIDED",
            "LONG_TERM"
          ]
        },
        provider: STR,
        eligibleAmount: MONEY,
        coverageAmount: MONEY,
        frequency: STR,
        startDate: CAL,
        expiryDate: CAL,
        linkedSalaryDeductionId: OID,
        carryForward: BOOL
      },
      ["name"]
    ),
    indexes: [
      idx("by_member_status", { householdId: 1, memberId: 1, status: 1 })
    ]
  },

  benefit_claims: {
    validator: householdValidator(
      {
        benefitId: OID,
        eligibleAmount: MONEY,
        claimedAmount: MONEY,
        approvedAmount: MONEY,
        receivedAmount: MONEY,
        remainingAmount: MONEY,
        claimDate: CAL,
        approvedDate: CAL,
        receivedDate: CAL,
        linkedExpenseIds: OID_ARR,
        rejectionReason: STR
      }
    ),
    indexes: [
      idx("by_benefit", { householdId: 1, benefitId: 1, claimDate: -1 })
    ]
  },

  /* 5. Accounts & transactions -------------------------------------------- */

  accounts: {
    validator: householdValidator(
      {
        name: STR,
        accountType: {
          enum: ["SAVINGS", "CURRENT", "SALARY", "CASH", "WALLET", "FIXED_DEPOSIT", "OTHER"]
        },
        institution: STR,
        maskedAccountNumber: { bsonType: "string", maxLength: 4 },
        openingBalance: MONEY,
        currentBalance: MONEY,
        balanceAsOf: DATE,
        isPrimary: BOOL
      },
      ["name"]
    ),
    indexes: [
      idx("by_household_status", { householdId: 1, status: 1 })
    ]
  },

  transactions: {
    validator: householdValidator(
      {
        accountId: OID,
        transactionType: {
          enum: [
            "INCOME",
            "EXPENSE",
            "TRANSFER",
            "REFUND",
            "REIMBURSEMENT",
            "LOAN_PAYMENT",
            "INVESTMENT",
            "ADJUSTMENT"
          ]
        },
        amount: MONEY,
        transactionDate: DATE,
        description: STR,
        merchant: STR,
        linkedEntityType: STR,
        linkedEntityId: OID,
        importReference: STR,
        balanceAfter: MONEY
      },
      ["transactionType", "transactionDate"]
    ),
    indexes: [
      idx("by_date", { householdId: 1, transactionDate: -1 }),
      idx("by_account_date", { householdId: 1, accountId: 1, transactionDate: -1 }),
      idx(
        "by_import_ref",
        { householdId: 1, importReference: 1 },
        { sparse: true }
      )
    ]
  },

  /* 6. Expenses & bills ---------------------------------------------------- */

  expense_categories: {
    validator: validator(
      {
        householdId: { bsonType: ["objectId", "null"] },
        name: STR,
        parentCategoryId: { bsonType: ["objectId", "null"] },
        icon: STR,
        colorHex: STR,
        systemCategory: BOOL,
        categoryGroup: {
          enum: [
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
          ]
        },
        isActive: BOOL,
        displayOrder: INT
      },
      ["name"]
    ),
    indexes: [
      idx("by_household_group", { householdId: 1, categoryGroup: 1, isActive: 1 }),
      idx("by_parent", { householdId: 1, parentCategoryId: 1, displayOrder: 1 })
    ]
  },

  expenses: {
    validator: householdValidator(
      {
        paidByMemberId: OID,
        beneficiaryMemberIds: OID_ARR,
        accountId: OID,
        amount: MONEY,
        baseAmount: MONEY,
        baseCurrency: CURRENCY,
        fxRate: DECIMAL,
        expenseDate: DATE,
        merchant: STR,
        categoryId: OID,
        subcategoryId: OID,
        ownership: { enum: ["PERSONAL", "SHARED", "HOUSEHOLD"] },
        nature: { enum: ["FIXED", "VARIABLE"] },
        costType: { enum: ["ESSENTIAL", "DISCRETIONARY"] },
        planningType: { enum: ["PLANNED", "UNPLANNED"] },
        spendingType: { enum: ["NEED", "WANT"] },
        priority: STR,
        paymentMethod: { enum: ["CASH", "CARD", "UPI", "NETBANKING", "AUTO_DEBIT"] },
        reimbursementStatus: {
          enum: ["NOT_APPLICABLE", "PENDING", "CLAIMED", "RECEIVED"]
        },
        receiptDocumentId: OID,
        tags: STR_ARR
      },
      ["expenseDate"]
    ),
    indexes: [
      idx("by_date", { householdId: 1, expenseDate: -1 }),
      idx("by_category_date", { householdId: 1, categoryId: 1, expenseDate: -1 }),
      idx("by_payer_date", { householdId: 1, paidByMemberId: 1, expenseDate: -1 })
    ]
  },

  expense_rules: {
    validator: householdValidator(
      {
        matchType: { enum: ["MERCHANT_CONTAINS", "MERCHANT_EXACT", "REGEX"] },
        matchValue: STR,
        categoryId: OID,
        priority: INT,
        isActive: BOOL,
        createdFromCorrection: BOOL,
        timesApplied: INT
      },
      ["matchType", "matchValue", "categoryId"]
    ),
    indexes: [
      idx("by_household_priority", { householdId: 1, isActive: 1, priority: -1 }),
      idx("by_match", { householdId: 1, matchType: 1, matchValue: 1 })
    ]
  },

  bill_definitions: {
    validator: householdValidator(
      {
        name: STR,
        provider: STR,
        categoryId: OID,
        expectedAmount: MONEY,
        recurrence: { enum: ["MONTHLY", "QUARTERLY", "ANNUAL", "CUSTOM"] },
        dueDateRule: OBJ,
        payerMemberId: OID,
        accountId: OID,
        autoPay: BOOL,
        reminderRules: ARR
      },
      ["name"]
    ),
    indexes: [
      idx("by_household_status", { householdId: 1, status: 1 })
    ]
  },

  bill_instances: {
    validator: householdValidator(
      {
        billDefinitionId: OID,
        period: { bsonType: "string", pattern: "^\\d{4}-\\d{2}$" },
        expectedAmount: MONEY,
        actualAmount: MONEY,
        dueDate: CAL,
        paidDate: CAL,
        linkedExpenseId: OID,
        sourceDocumentId: OID,
        status: { enum: ["DUE", "PAID", "OVERDUE", "SKIPPED", "PARTIAL"] }
      },
      ["billDefinitionId", "period"]
    ),
    indexes: [
      idx(
        "uniq_definition_period",
        { householdId: 1, billDefinitionId: 1, period: 1 },
        { unique: true }
      ),
      idx("by_due_status", { householdId: 1, dueDate: 1, status: 1 })
    ]
  },

  /* 7. Budgets & allocation ------------------------------------------------ */

  budgets: {
    validator: householdValidator(
      {
        name: STR,
        method: {
          enum: ["ZERO_BASED", "FIFTY_THIRTY_TWENTY", "ENVELOPE", "CUSTOM"]
        },
        recurrence: STR,
        isActive: BOOL,
        startDate: CAL
      },
      ["name"]
    ),
    indexes: [
      idx("by_household_active", { householdId: 1, isActive: 1 })
    ]
  },

  budget_periods: {
    validator: householdValidator(
      {
        budgetId: OID,
        periodStart: DATE,
        periodEnd: DATE,
        plannedIncome: MONEY,
        plannedExpense: MONEY,
        actualIncome: MONEY,
        actualExpense: MONEY,
        status: { enum: ["DRAFT", "ACTIVE", "CLOSED"] }
      },
      ["budgetId", "periodStart", "periodEnd"]
    ),
    indexes: [
      idx("by_budget_period", { householdId: 1, budgetId: 1, periodStart: -1 })
    ]
  },

  budget_buckets: {
    validator: householdValidator(
      {
        budgetPeriodId: OID,
        categoryId: OID,
        plannedAmount: MONEY,
        actualAmount: MONEY,
        carryForward: BOOL,
        rolloverAmount: MONEY
      },
      ["budgetPeriodId"]
    ),
    indexes: [
      idx("by_period_category", { householdId: 1, budgetPeriodId: 1, categoryId: 1 })
    ]
  },

  budget_rules: {
    validator: householdValidator(
      {
        ruleType: STR,
        categoryId: OID,
        thresholdPercent: DOUBLE,
        thresholdAmount: MONEY,
        action: { enum: ["NOTIFY", "BLOCK", "FLAG"] }
      },
      ["ruleType"]
    ),
    indexes: [
      idx("by_household_rule", { householdId: 1, ruleType: 1 })
    ]
  },

  allocation_plans: {
    validator: householdValidator(
      {
        name: STR,
        totalAmount: MONEY,
        planDate: CAL,
        status: STR
      }
    ),
    indexes: [
      idx("by_plan_date", { householdId: 1, planDate: -1 })
    ]
  },

  allocation_items: {
    validator: householdValidator(
      {
        planId: OID,
        targetType: {
          enum: ["GOAL", "LOAN", "INVESTMENT", "EMERGENCY_FUND", "EXPENSE"]
        },
        targetId: OID,
        amount: MONEY,
        percentage: DOUBLE,
        displayOrder: INT
      },
      ["planId"]
    ),
    indexes: [
      idx("by_plan", { householdId: 1, planId: 1, displayOrder: 1 })
    ]
  },

  /* 8. Debt --------------------------------------------------------------- */

  loans: {
    validator: householdValidator(
      {
        name: STR,
        loanType: {
          enum: ["HOME", "AUTO", "PERSONAL", "EDUCATION", "GOLD", "BUSINESS", "OTHER"]
        },
        lender: STR,
        borrowerMemberIds: OID_ARR,
        originalPrincipal: MONEY,
        outstandingPrincipal: MONEY,
        interestRate: DECIMAL,
        interestType: { enum: ["FIXED", "FLOATING", "REDUCING", "FLAT"] },
        emiAmount: MONEY,
        tenureMonths: INT,
        remainingMonths: INT,
        startDate: CAL,
        expectedEndDate: CAL,
        dueDay: { bsonType: "int", minimum: 1, maximum: 31 },
        accountId: OID
      },
      ["name"]
    ),
    indexes: [
      idx("by_household_status", { householdId: 1, status: 1 })
    ]
  },

  loan_payments: {
    validator: householdValidator(
      {
        loanId: OID,
        paymentDate: DATE,
        totalAmount: MONEY,
        principalComponent: MONEY,
        interestComponent: MONEY,
        extraPayment: MONEY,
        outstandingAfter: MONEY,
        paymentType: { enum: ["EMI", "PREPAYMENT", "FORECLOSURE"] },
        linkedTransactionId: OID
      },
      ["loanId", "paymentDate"]
    ),
    indexes: [
      idx("by_loan_date", { householdId: 1, loanId: 1, paymentDate: -1 }),
      idx("by_household_date", { householdId: 1, paymentDate: -1 })
    ]
  },

  credit_cards: {
    validator: householdValidator(
      {
        issuer: STR,
        nickname: STR,
        maskedCardNumber: { bsonType: "string", maxLength: 4 },
        creditLimit: MONEY,
        outstanding: MONEY,
        minimumDue: MONEY,
        totalDue: MONEY,
        statementDay: { bsonType: "int", minimum: 1, maximum: 31 },
        dueDay: { bsonType: "int", minimum: 1, maximum: 31 },
        interestRate: DECIMAL
      }
    ),
    indexes: [
      idx("by_household_status", { householdId: 1, status: 1 })
    ]
  },

  /* 9. Wealth -------------------------------------------------------------- */

  investments: {
    validator: householdValidator(
      {
        investmentType: {
          enum: [
            "MUTUAL_FUND",
            "STOCK",
            "FD",
            "RD",
            "PPF",
            "EPF",
            "NPS",
            "BOND",
            "GOLD",
            "CRYPTO",
            "REAL_ESTATE",
            "OTHER"
          ]
        },
        name: STR,
        provider: STR,
        accountReferenceMasked: { bsonType: "string", maxLength: 4 },
        totalContribution: MONEY,
        currentValue: MONEY,
        liquidity: { enum: ["LIQUID", "SEMI_LIQUID", "LOCKED"] },
        maturityDate: CAL,
        expectedReturnAssumption: DOUBLE,
        riskLabel: STR,
        sipAmount: MONEY,
        sipDay: { bsonType: "int", minimum: 1, maximum: 31 }
      },
      ["name"]
    ),
    indexes: [
      idx("by_owner_status", { householdId: 1, ownerMemberId: 1, status: 1 })
    ]
  },

  investment_transactions: {
    validator: householdValidator(
      {
        investmentId: OID,
        transactionDate: DATE,
        transactionType: {
          enum: ["BUY", "SELL", "SIP", "DIVIDEND", "INTEREST", "BONUS", "MATURITY"]
        },
        amount: MONEY,
        units: DECIMAL,
        pricePerUnit: DECIMAL,
        charges: MONEY,
        linkedTransactionId: OID
      },
      ["investmentId", "transactionDate"]
    ),
    indexes: [
      idx(
        "by_investment_date",
        { householdId: 1, investmentId: 1, transactionDate: -1 }
      )
    ]
  },

  investment_closures: {
    validator: householdValidator(
      {
        investmentId: OID,
        closureDate: CAL,
        closureType: { enum: ["MATURITY", "REDEMPTION", "SALE", "TRANSFER"] },
        releasedAmount: MONEY,
        destinationType: {
          enum: ["GOAL", "LOAN", "CREDIT_CARD", "EXPENSE", "ACCOUNT"]
        },
        destinationId: OID,
        matchStatus: { enum: ["MATCHED", "UNMATCHED"] }
      },
      ["investmentId", "closureDate"]
    ),
    indexes: [
      idx("by_investment", { householdId: 1, investmentId: 1, closureDate: -1 }),
      idx("by_match_status", { householdId: 1, matchStatus: 1, closureDate: -1 })
    ]
  },

  assets: {
    validator: householdValidator(
      {
        name: STR,
        assetType: { enum: ["PROPERTY", "VEHICLE", "JEWELLERY", "EQUIPMENT"] },
        purchaseValue: MONEY,
        currentValue: MONEY,
        purchaseDate: CAL,
        valuationDate: CAL,
        depreciationRate: DOUBLE
      },
      ["name"]
    ),
    indexes: [
      idx("by_household_status", { householdId: 1, status: 1 })
    ]
  },

  liabilities: {
    validator: householdValidator(
      {
        name: STR,
        liabilityType: { enum: ["INFORMAL_LOAN", "PAYABLE", "TAX_DUE", "OTHER"] },
        amount: MONEY,
        counterparty: STR,
        dueDate: CAL
      },
      ["name"]
    ),
    indexes: [
      idx("by_household_status", { householdId: 1, status: 1 })
    ]
  },

  /* 10. Goals & protection ------------------------------------------------- */

  goals: {
    validator: householdValidator(
      {
        name: STR,
        goalType: {
          enum: ["EDUCATION", "RETIREMENT", "HOME", "VEHICLE", "TRAVEL", "WEDDING", "EMERGENCY", "OTHER"]
        },
        ownerMemberIds: OID_ARR,
        beneficiaryMemberIds: OID_ARR,
        targetAmount: MONEY,
        currentAmount: MONEY,
        targetDate: CAL,
        priority: { bsonType: ["string", "int"] },
        monthlyContribution: MONEY,
        linkedInvestmentIds: OID_ARR,
        inflationRate: DOUBLE
      },
      ["name"]
    ),
    indexes: [
      idx("by_household_status", { householdId: 1, status: 1 })
    ]
  },

  goal_contributions: {
    validator: householdValidator(
      {
        goalId: OID,
        contributionDate: DATE,
        amount: MONEY,
        contributorMemberId: OID,
        sourceType: { enum: ["MANUAL", "SIP", "WINDFALL", "INVESTMENT_CLOSURE"] },
        linkedTransactionId: OID
      },
      ["goalId", "contributionDate"]
    ),
    indexes: [
      idx("by_goal_date", { householdId: 1, goalId: 1, contributionDate: -1 })
    ]
  },

  emergency_fund_plans: {
    validator: householdValidator(
      {
        targetMonths: INT,
        monthlyExpenseBasis: MONEY,
        targetAmount: MONEY,
        currentAmount: MONEY,
        linkedAccountIds: OID_ARR,
        status: STR
      }
    ),
    indexes: [
      idx("uniq_household", { householdId: 1 }, { unique: true })
    ]
  },

  insurance_policies: {
    validator: householdValidator(
      {
        policyType: {
          enum: ["TERM_LIFE", "HEALTH", "MOTOR", "HOME", "TRAVEL", "CRITICAL_ILLNESS", "ACCIDENT", "OTHER"]
        },
        provider: STR,
        policyReferenceMasked: { bsonType: "string", maxLength: 4 },
        policyHolderMemberId: OID,
        coveredMemberIds: OID_ARR,
        coverageAmount: MONEY,
        premiumAmount: MONEY,
        premiumFrequency: STR,
        startDate: CAL,
        expiryDate: CAL,
        renewalDate: CAL,
        documentId: OID
      }
    ),
    indexes: [
      idx("by_status", { householdId: 1, status: 1 }),
      idx("by_renewal", { householdId: 1, renewalDate: 1 })
    ]
  },

  /* 11. Periods & snapshots ------------------------------------------------ */

  financial_periods: {
    validator: householdValidator(
      {
        periodType: { enum: ["MONTH", "QUARTER", "YEAR"] },
        startDate: DATE,
        endDate: DATE,
        status: { enum: ["OPEN", "CLOSED"] },
        closedAt: DATE
      },
      ["periodType", "startDate", "endDate"]
    ),
    indexes: [
      idx("by_period", { householdId: 1, periodType: 1, startDate: -1 })
    ]
  },

  financial_snapshots: {
    validator: householdValidator(
      {
        periodStart: DATE,
        periodEnd: DATE,
        totalIncome: MONEY,
        totalExpense: MONEY,
        totalSavings: MONEY,
        netWorth: MONEY,
        totalAssets: MONEY,
        totalLiabilities: MONEY,
        savingsRate: DOUBLE,
        categoryBreakdown: OBJ,
        computedAt: DATE
      },
      ["periodStart"]
    ),
    indexes: [
      idx("by_period_start", { householdId: 1, periodStart: -1 })
    ]
  },

  household_financial_summary: {
    validator: householdValidator(
      {
        financialPeriod: { bsonType: "string", pattern: "^\\d{4}-\\d{2}$" }
      },
      ["financialPeriod"]
    ),
    indexes: [
      idx(
        "uniq_household_period",
        { householdId: 1, financialPeriod: 1 },
        { unique: true }
      )
    ]
  },

  /* 12. Audit & activity --------------------------------------------------- */

  audit_findings: {
    validator: householdValidator(
      {
        dedupeKey: STR,
        category: STR,
        severity: { enum: ["INFO", "ATTENTION", "HIGH", "CRITICAL"] },
        title: STR,
        expectedValue: MONEY,
        actualValue: MONEY,
        varianceAmount: MONEY,
        variancePercent: DOUBLE,
        rootCause: {
          enum: ["TRANSACTION_VOLUME", "TRANSACTION_VALUE", "NEW_CATEGORY", "ONE_OFF", "UNKNOWN"]
        },
        financialImpact: MONEY,
        evidenceTransactionIds: OID_ARR,
        recommendedActions: ARR,
        periodStart: DATE,
        detectedAt: DATE,
        status: {
          enum: ["OPEN", "REVIEWED", "RESOLVED", "ACCEPTED", "IGNORED", "SNOOZED", "AUTO_RESOLVED"]
        },
        acceptedVariance: MONEY,
        snoozedUntil: DATE,
        dataQuality: STR
      },
      ["dedupeKey"]
    ),
    indexes: [
      idx("by_status_detected", { householdId: 1, status: 1, detectedAt: -1 }),
      idx("by_category_period", { householdId: 1, category: 1, periodStart: -1 }),
      idx("uniq_dedupe", { householdId: 1, dedupeKey: 1 }, { unique: true })
    ]
  },

  audit_runs: {
    validator: householdValidator(
      {
        runType: { enum: ["MONTHLY", "QUARTERLY", "ANNUAL", "ON_DEMAND"] },
        startedAt: DATE,
        completedAt: DATE,
        findingsCount: INT,
        status: STR
      },
      ["runType", "startedAt"]
    ),
    indexes: [
      idx("by_started", { householdId: 1, startedAt: -1 })
    ]
  },

  audit_logs: {
    validator: householdValidator(
      {
        correlationId: STR,
        actorUserId: OID,
        action: STR,
        entityType: STR,
        entityId: OID,
        beforeValue: OBJ,
        afterValue: OBJ,
        ipAddress: STR
      },
      ["action"]
    ),
    indexes: [
      idx("by_created", { householdId: 1, createdAt: -1 }),
      idx("by_correlation", { householdId: 1, correlationId: 1 })
    ]
  },

  activity_logs: {
    validator: householdValidator(
      {
        actorUserId: OID,
        activityType: STR,
        summary: STR,
        entityType: STR,
        entityId: OID
      }
    ),
    indexes: [
      idx("by_created", { householdId: 1, createdAt: -1 })
    ]
  },

  /* 13. Notifications ------------------------------------------------------ */

  notifications: {
    validator: validator(
      {
        userId: OID,
        householdId: OID,
        dedupeKey: STR,
        type: STR,
        severity: STR,
        title: STR,
        body: STR,
        actionRoute: STR,
        entityType: STR,
        entityId: OID,
        readAt: DATE,
        createdAt: DATE,
        expiresAt: DATE
      },
      ["userId", "type", "title", "createdAt"]
    ),
    indexes: [
      idx("by_user_unread", { userId: 1, readAt: 1, createdAt: -1 }),
      idx(
        "uniq_user_dedupe",
        { userId: 1, dedupeKey: 1 },
        { unique: true, sparse: true }
      )
    ]
  },

  notification_preferences: {
    validator: validator(
      {
        userId: OID,
        channelEmail: BOOL,
        channelPush: BOOL,
        channelInApp: BOOL,
        billReminders: BOOL,
        budgetAlerts: BOOL,
        auditFindings: BOOL,
        goalMilestones: BOOL,
        quietHoursStart: STR,
        quietHoursEnd: STR,
        reminderLeadDays: INT
      },
      ["userId"]
    ),
    indexes: [
      idx("uniq_user", { userId: 1 }, { unique: true })
    ]
  },

  /* 14. Documents ---------------------------------------------------------- */

  documents: {
    validator: householdValidator(
      {
        documentType: STR,
        filename: STR,
        mimeType: STR,
        storageType: { enum: ["GRIDFS", "OBJECT_STORAGE"] },
        storageReference: { bsonType: ["objectId", "string"] },
        pageCount: INT,
        fileSizeBytes: INT,
        linkedEntityType: STR,
        linkedEntityId: OID,
        processingStatus: {
          enum: ["PENDING", "PROCESSING", "EXTRACTED", "CONFIRMED", "FAILED"]
        },
        uploadedBy: OID,
        uploadedAt: DATE,
        confirmedAt: DATE
      },
      ["filename"]
    ),
    indexes: [
      idx("by_type_uploaded", { householdId: 1, documentType: 1, uploadedAt: -1 })
    ]
  },

  document_extraction_results: {
    validator: householdValidator(
      {
        documentId: OID,
        detectedType: STR,
        typeConfidence: { bsonType: "double", minimum: 0, maximum: 1 },
        extractedFields: ARR,
        transactions: ARR,
        unresolvedFields: ARR,
        providerId: STR,
        detectedLanguage: STR,
        warnings: ARR
      },
      ["documentId"]
    ),
    indexes: [
      idx("by_document", { householdId: 1, documentId: 1, createdAt: -1 })
    ]
  },

  document_corrections: {
    validator: householdValidator(
      {
        documentId: OID,
        fieldName: STR,
        extractedValue: STR,
        correctedValue: STR,
        documentType: STR,
        correctedAt: DATE
      },
      ["documentId", "fieldName"]
    ),
    indexes: [
      idx("by_document_field", { householdId: 1, documentId: 1, fieldName: 1 })
    ]
  },

  /* 15. AI ---------------------------------------------------------------- */

  ai_conversations: {
    validator: validator(
      {
        userId: OID,
        householdId: OID,
        title: STR,
        createdAt: DATE,
        updatedAt: DATE,
        messageCount: INT
      },
      ["userId"]
    ),
    indexes: [
      idx("by_user_updated", { userId: 1, updatedAt: -1 }),
      idx("by_household_updated", { householdId: 1, updatedAt: -1 }, { sparse: true })
    ]
  },

  ai_messages: {
    validator: validator(
      {
        conversationId: OID,
        role: { enum: ["USER", "ASSISTANT", "SYSTEM"] },
        content: STR,
        tokensUsed: INT,
        providerId: STR,
        createdAt: DATE
      },
      ["conversationId", "role", "content"]
    ),
    indexes: [
      idx("by_conversation", { conversationId: 1, createdAt: 1 })
    ]
  },

  ai_action_proposals: {
    validator: householdValidator(
      {
        proposedAction: STR,
        targetEntityType: STR,
        payload: OBJ,
        rationale: STR,
        status: { enum: ["PROPOSED", "ACCEPTED", "REJECTED", "EXPIRED"] },
        expiresAt: DATE
      },
      ["proposedAction"]
    ),
    indexes: [
      idx("by_household_status", { householdId: 1, status: 1, createdAt: -1 }),
      idx("ttl_expires", { expiresAt: 1 }, { expireAfterSeconds: 0 })
    ]
  },

  /* 16. Search ------------------------------------------------------------- */

  search_documents: {
    validator: householdValidator(
      {
        entityType: STR,
        entityId: OID,
        title: STR,
        keywords: STR_ARR,
        searchText: STR,
        amount: MONEY,
        date: DATE,
        memberIds: OID_ARR
      },
      ["entityType", "entityId"]
    ),
    indexes: [
      idx(
        "uniq_entity",
        { householdId: 1, entityType: 1, entityId: 1 },
        { unique: true }
      ),
      idx(
        "text_search",
        { title: "text", keywords: "text", searchText: "text" },
        { weights: { title: 10, keywords: 5, searchText: 1 } }
      ),
      idx("by_date", { householdId: 1, date: -1 })
    ]
  },

  recent_searches: {
    validator: validator(
      {
        userId: OID,
        householdId: OID,
        query: STR,
        resultCount: INT,
        createdAt: DATE
      },
      ["userId", "query", "createdAt"]
    ),
    indexes: [
      idx("by_user_created", { userId: 1, createdAt: -1 })
    ]
  },

  recently_viewed: {
    validator: validator(
      {
        userId: OID,
        householdId: OID,
        entityType: STR,
        entityId: OID,
        title: STR,
        viewedAt: DATE
      },
      ["userId", "entityType", "entityId", "viewedAt"]
    ),
    indexes: [
      idx("by_user_viewed", { userId: 1, viewedAt: -1 })
    ]
  },

  /* 17. Journal & planning ------------------------------------------------- */

  decision_journal_entries: {
    validator: householdValidator(
      {
        decisionDate: DATE,
        title: STR,
        context: STR,
        decision: STR,
        expectedOutcome: STR,
        actualOutcome: STR,
        reviewDate: CAL,
        linkedEntityType: STR,
        linkedEntityId: OID
      },
      ["decisionDate", "title"]
    ),
    indexes: [
      idx("by_decision_date", { householdId: 1, decisionDate: -1 })
    ]
  },

  life_events: {
    validator: householdValidator(
      {
        eventType: {
          enum: ["MARRIAGE", "CHILD", "JOB_CHANGE", "RELOCATION", "RETIREMENT", "BEREAVEMENT", "ILLNESS"]
        },
        targetDate: CAL,
        affectedMemberIds: OID_ARR,
        estimatedCost: MONEY,
        planningStatus: STR
      },
      ["eventType"]
    ),
    indexes: [
      idx("by_target_date", { householdId: 1, targetDate: 1 })
    ]
  },

  /* 18. Commerce ----------------------------------------------------------- */

  subscriptions: {
    validator: householdValidator(
      {
        plan: { enum: ["FREE", "PLUS", "FAMILY"] },
        status: { enum: ["ACTIVE", "TRIAL", "GRACE", "EXPIRED", "CANCELLED"] },
        platform: { enum: ["APPLE", "GOOGLE", "WEB"] },
        storeTransactionId: STR,
        originalPurchaseDate: DATE,
        currentPeriodEnd: DATE,
        autoRenew: BOOL,
        verifiedAt: DATE
      },
      ["plan", "status"]
    ),
    indexes: [
      idx("by_household_status", { householdId: 1, status: 1 })
    ]
  },

  entitlements: {
    validator: householdValidator(
      {
        featureCode: STR,
        isEnabled: BOOL,
        limitValue: { bsonType: ["int", "null"] },
        source: { enum: ["PLAN", "PROMO", "MANUAL"] },
        expiresAt: DATE
      },
      ["featureCode"]
    ),
    indexes: [
      idx(
        "uniq_household_feature",
        { householdId: 1, featureCode: 1 },
        { unique: true }
      )
    ]
  },

  /* 19. Platform ----------------------------------------------------------- */

  domain_events: {
    validator: validator(
      {
        eventId: STR,
        eventType: STR,
        householdId: OID,
        payload: OBJ,
        occurredAt: DATE,
        processingStatus: {
          enum: ["PENDING", "PROCESSING", "PROCESSED", "FAILED"]
        },
        attempts: INT
      },
      ["eventId", "eventType", "occurredAt"]
    ),
    indexes: [
      idx("by_status_occurred", { processingStatus: 1, occurredAt: 1 }),
      idx("uniq_event", { eventId: 1 }, { unique: true })
    ]
  },

  background_jobs: {
    validator: validator(
      {
        jobType: STR,
        householdId: OID,
        status: { enum: ["QUEUED", "RUNNING", "DONE", "FAILED"] },
        runAfter: DATE,
        attempts: INT,
        lastError: STR,
        payload: OBJ
      },
      ["jobType", "status"]
    ),
    indexes: [
      idx("by_status_run_after", { status: 1, runAfter: 1 })
    ]
  },

  data_export_jobs: {
    validator: validator(
      {
        userId: OID,
        householdId: OID,
        scope: { enum: ["SELF", "HOUSEHOLD"] },
        format: { enum: ["JSON", "CSV", "PDF"] },
        status: STR,
        fileReference: STR,
        requestedAt: DATE,
        completedAt: DATE,
        expiresAt: DATE
      },
      ["userId", "requestedAt"]
    ),
    indexes: [
      idx("by_user_requested", { userId: 1, requestedAt: -1 }),
      idx("ttl_expires", { expiresAt: 1 }, { expireAfterSeconds: 0 })
    ]
  },

  database_schema_version: {
    validator: validator(
      {
        version: INT,
        appliedAt: DATE,
        description: STR
      },
      ["version"]
    ),
    indexes: [
      idx("uniq_version", { version: 1 }, { unique: true })
    ]
  }
};

/* -------------------------------------------------------------------------- */
/* Seed data                                                                  */
/* -------------------------------------------------------------------------- */

const SYSTEM_ROLES = [
  { code: "HOUSEHOLD_ADMIN", name: "Household Admin", rank: 1, isSystem: true },
  { code: "FINANCIAL_PARTNER", name: "Financial Partner", rank: 2, isSystem: true },
  { code: "MEMBER", name: "Member", rank: 3, isSystem: true },
  { code: "VIEW_ONLY", name: "View Only", rank: 4, isSystem: true },
  { code: "GOAL_CONTRIBUTOR", name: "Goal Contributor", rank: 5, isSystem: true }
];

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

const PERMISSION_ACTIONS = ["read", "create", "update", "delete"];

const SYSTEM_EXPENSE_GROUPS = [
  ["HOUSING", "Housing"],
  ["UTILITIES", "Utilities"],
  ["FOOD", "Food"],
  ["TRANSPORT", "Transport"],
  ["FAMILY", "Family"],
  ["HEALTH", "Health"],
  ["LIFESTYLE", "Lifestyle"],
  ["FINANCIAL", "Financial"],
  ["SUBSCRIPTIONS", "Subscriptions"],
  ["EDUCATION", "Education"],
  ["OTHER", "Other"]
];

/* -------------------------------------------------------------------------- */
/* Initializer operations                                                     */
/* -------------------------------------------------------------------------- */

async function collectionExists(db, name) {
  return db.listCollections({ name }, { nameOnly: true }).hasNext();
}

async function ensureCollection(db, name, def) {
  const exists = await collectionExists(db, name);

  if (!exists) {
    await db.createCollection(name, {
      validator: def.validator,
      validationLevel: "strict",
      validationAction: "error"
    });
    console.log(`  + created collection: ${name}`);
    return;
  }

  try {
    await db.command({
      collMod: name,
      validator: def.validator,
      validationLevel: "strict",
      validationAction: "error"
    });
    console.log(`  = validator updated: ${name}`);
  } catch (error) {
    // collMod can require additional DB privileges on some Atlas roles.
    if (error && (error.code === 13 || error.codeName === "Unauthorized")) {
      console.warn(
        `  ! ${name}: collection exists, but validator could not be updated (collMod permission missing).`
      );
      console.warn(
        "    Grant dbAdmin for family_finance temporarily if you need to update validators on existing collections."
      );
    } else {
      throw error;
    }
  }
}

async function ensureIndexes(db, name, indexDefs = []) {
  if (!indexDefs.length) return;

  const existing = await db.collection(name).indexes();
  const existingNames = new Set(existing.map((x) => x.name));

  for (const indexDef of indexDefs) {
    if (existingNames.has(indexDef.name)) {
      console.log(`  = index exists: ${name}.${indexDef.name}`);
      continue;
    }

    try {
      await db.collection(name).createIndex(
        indexDef.key,
        { name: indexDef.name, ...indexDef.options }
      );
      console.log(`  + index created: ${name}.${indexDef.name}`);
    } catch (error) {
      console.error(`  x index failed: ${name}.${indexDef.name}`);
      throw error;
    }
  }
}

async function seedRoles(db) {
  console.log("\nSeeding roles...");

  for (const role of SYSTEM_ROLES) {
    await db.collection("roles").updateOne(
      { code: role.code },
      { $set: role },
      { upsert: true }
    );
    console.log(`  = role: ${role.code}`);
  }
}

async function seedPermissions(db) {
  console.log("\nSeeding permissions...");

  const operations = [];

  for (const entity of PERMISSION_ENTITIES) {
    for (const action of PERMISSION_ACTIONS) {
      const code = `${entity}.${action}`;
      operations.push({
        updateOne: {
          filter: { code },
          update: {
            $set: { code, entity, action }
          },
          upsert: true
        }
      });
    }
  }

  if (operations.length) {
    await db.collection("permissions").bulkWrite(operations, { ordered: false });
  }

  console.log(`  = permissions ensured: ${operations.length}`);
}

async function seedExpenseCategories(db) {
  console.log("\nSeeding top-level system expense categories...");

  /*
   * The supplied schema names the 11 category groups but does not provide the
   * child category list that it says exists in schema.js.
   *
   * To stay faithful to the supplied source, this initializer seeds only those
   * 11 supported top-level system groups. Child categories can be added later
   * without changing these records.
   */
  for (let i = 0; i < SYSTEM_EXPENSE_GROUPS.length; i++) {
    const [categoryGroup, name] = SYSTEM_EXPENSE_GROUPS[i];

    await db.collection("expense_categories").updateOne(
      {
        householdId: null,
        systemCategory: true,
        categoryGroup,
        parentCategoryId: null
      },
      {
        $set: {
          householdId: null,
          name,
          parentCategoryId: null,
          systemCategory: true,
          categoryGroup,
          isActive: true,
          displayOrder: i + 1
        }
      },
      { upsert: true }
    );

    console.log(`  = system category: ${categoryGroup}`);
  }
}

async function seedSchemaVersion(db) {
  console.log("\nRecording schema version...");

  await db.collection("database_schema_version").updateOne(
    { version: SCHEMA_VERSION },
    {
      $setOnInsert: {
        version: SCHEMA_VERSION,
        appliedAt: new Date(),
        description:
          "FamFin initial MongoDB schema; 64 base collections plus expense_rules, investment_closures and document_corrections."
      }
    },
    { upsert: true }
  );

  console.log(`  = schema version: ${SCHEMA_VERSION}`);
}

async function initializeDatabase() {
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000
  });

  try {
    console.log("============================================================");
    console.log("FAMFIN MONGODB INITIALIZER");
    console.log("============================================================");
    console.log(`Database: ${DB_NAME}`);
    console.log(`Schema version: ${SCHEMA_VERSION}`);
    console.log(`Collections to ensure: ${Object.keys(collections).length}`);
    console.log("");

    console.log("Connecting to MongoDB Atlas...");
    await client.connect();

    const db = client.db(DB_NAME);
    await db.command({ ping: 1 });

    console.log("Connected successfully.\n");

    console.log("Creating/updating collections and validators...");

    for (const [name, def] of Object.entries(collections)) {
      await ensureCollection(db, name, def);
    }

    console.log("\nCreating indexes...");

    for (const [name, def] of Object.entries(collections)) {
      await ensureIndexes(db, name, def.indexes || []);
    }

    await seedRoles(db);
    await seedPermissions(db);
    await seedExpenseCategories(db);
    await seedSchemaVersion(db);

    const names = await db
      .listCollections({}, { nameOnly: true })
      .toArray();

    const requiredNames = new Set(Object.keys(collections));
    const createdCount = names.filter((x) => requiredNames.has(x.name)).length;

    console.log("\n============================================================");
    console.log("FAMFIN DATABASE INITIALIZATION COMPLETE");
    console.log("============================================================");
    console.log(`Database: ${DB_NAME}`);
    console.log(`Expected application collections: ${Object.keys(collections).length}`);
    console.log(`Application collections present: ${createdCount}`);
    console.log(`System roles: ${SYSTEM_ROLES.length}`);
    console.log(
      `Permissions: ${PERMISSION_ENTITIES.length} x ${PERMISSION_ACTIONS.length} = ${
        PERMISSION_ENTITIES.length * PERMISSION_ACTIONS.length
      }`
    );
    console.log(`Top-level system expense categories: ${SYSTEM_EXPENSE_GROUPS.length}`);
    console.log(`Schema version: ${SCHEMA_VERSION}`);
    console.log("");
    console.log("You can safely run this initializer again.");
    console.log("");
    console.log("Next:");
    console.log("  node verify-db.js");
    console.log("============================================================");
  } catch (error) {
    console.error("\nFAMFIN DATABASE INITIALIZATION FAILED");
    console.error("-------------------------------------");
    console.error(error);

    if (error && (error.code === 13 || error.codeName === "Unauthorized")) {
      console.error("");
      console.error("MongoDB user does not have enough privileges.");
      console.error(
        "For first-time schema creation/update, use a database user that can create collections/indexes and run collMod."
      );
    }

    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

initializeDatabase();
