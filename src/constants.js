const GENERIC_COLLECTIONS = [
  'family_members','income_sources','income_events','salary_structures','salary_components',
  'employer_benefits','benefit_claims','accounts','transactions','expense_categories',
  'expenses','bill_definitions','bill_instances','budgets','budget_periods','budget_buckets',
  'allocation_plans','loans','loan_payments','credit_cards','investments','investment_transactions',
  'assets','liabilities','goals','goal_contributions','emergency_fund_plans','insurance_policies',
  'decision_journal_entries','life_events','documents','audit_findings','notifications','financial_snapshots'
];

const PERMISSION_ENTITY = {
  family_members: 'family',
  income_sources: 'income',
  income_events: 'income',
  salary_structures: 'salary',
  salary_components: 'salary',
  employer_benefits: 'benefit',
  benefit_claims: 'benefit',
  accounts: 'account',
  transactions: 'transaction',
  expense_categories: 'expense',
  expenses: 'expense',
  bill_definitions: 'bill',
  bill_instances: 'bill',
  budgets: 'budget',
  budget_periods: 'budget',
  budget_buckets: 'budget',
  allocation_plans: 'budget',
  loans: 'loan',
  loan_payments: 'loan',
  credit_cards: 'card',
  investments: 'investment',
  investment_transactions: 'investment',
  assets: 'investment',
  liabilities: 'loan',
  goals: 'goal',
  goal_contributions: 'goal',
  emergency_fund_plans: 'goal',
  insurance_policies: 'insurance',
  decision_journal_entries: 'household',
  life_events: 'household',
  documents: 'document',
  audit_findings: 'audit',
  notifications: 'audit',
  financial_snapshots: 'budget'
};

const ALL_PERMISSION_ENTITIES = [
  'household','family','income','salary','benefit','expense','bill','account','transaction',
  'budget','loan','card','investment','goal','insurance','document','audit','export'
];
const ALL_PERMISSION_ACTIONS = ['read','create','update','delete'];

const SERVER_MANAGED_FIELDS = new Set([
  '_id','householdId','version','createdAt','updatedAt','createdBy','updatedBy','isDeleted','deletedAt'
]);

const U = ['status','ownerMemberId','visibility','currency','source','notes'];
const cfg = (fields, required = [], opts = {}) => ({
  fields: [...new Set([...fields, ...U])], required, money: [], decimal: [], dates: [], objectIds: [], objectIdArrays: [], ...opts
});

const COLLECTION_CONFIG = {
  family_members: cfg(['name','relationship','dateOfBirth','employmentStatus','financialRole','dependencyStatus','linkedUserId'], ['name'], {
    objectIds: ['linkedUserId']
  }),
  income_sources: cfg(['type','name','employerName','amount','frequency','expectedDateRule','reliability','confidence','startDate','endDate','isVariable','includeInBudget','isReimbursement'], ['name'], {
    money: ['amount']
  }),
  income_events: cfg(['incomeSourceId','memberId','expectedAmount','actualAmount','expectedDate','receivedDate','accountId','status','varianceReason'], [], {
    money: ['expectedAmount','actualAmount'], objectIds: ['incomeSourceId','memberId','accountId']
  }),
  salary_structures: cfg(['memberId','employmentId','effectiveFrom','effectiveTo','grossMonthly','takeHomeMonthly','mode'], ['effectiveFrom'], {
    money: ['grossMonthly','takeHomeMonthly'], objectIds: ['memberId','employmentId'], appendOnly: true
  }),
  salary_components: cfg(['salaryStructureId','componentType','name','amount','calculationType','percentageOf','isTaxable','isStatutory','linkedBenefitId','displayOrder'], ['salaryStructureId','componentType','name'], {
    money: ['amount'], objectIds: ['salaryStructureId','linkedBenefitId']
  }),
  employer_benefits: cfg(['memberId','employmentId','name','benefitType','classification','provider','eligibleAmount','coverageAmount','frequency','startDate','expiryDate','linkedSalaryDeductionId','carryForward'], ['name'], {
    money: ['eligibleAmount','coverageAmount'], objectIds: ['memberId','employmentId','linkedSalaryDeductionId']
  }),
  benefit_claims: cfg(['benefitId','eligibleAmount','claimedAmount','approvedAmount','receivedAmount','remainingAmount','claimDate','approvedDate','receivedDate','linkedExpenseIds','rejectionReason'], ['benefitId'], {
    money: ['eligibleAmount','claimedAmount','approvedAmount','receivedAmount','remainingAmount'], objectIds: ['benefitId'], objectIdArrays: ['linkedExpenseIds']
  }),
  accounts: cfg(['name','accountType','institution','maskedAccountNumber','openingBalance','currentBalance','balanceAsOf','isPrimary'], ['name'], {
    money: ['openingBalance','currentBalance'], dates: ['balanceAsOf'], maskFields: ['maskedAccountNumber']
  }),
  transactions: cfg(['accountId','transactionType','amount','transactionDate','description','merchant','linkedEntityType','linkedEntityId','importReference','balanceAfter'], ['transactionType','transactionDate'], {
    money: ['amount','balanceAfter'], dates: ['transactionDate'], objectIds: ['accountId','linkedEntityId']
  }),
  expense_categories: cfg(['name','parentCategoryId','icon','colorHex','systemCategory','categoryGroup','isActive','displayOrder'], ['name'], {
    objectIds: ['parentCategoryId'], systemShared: true
  }),
  expenses: cfg(['paidByMemberId','beneficiaryMemberIds','accountId','amount','baseAmount','baseCurrency','fxRate','expenseDate','merchant','description','categoryId','subcategoryId','ownership','nature','costType','planningType','spendingType','priority','paymentMethod','reimbursementStatus','receiptDocumentId','tags'], ['expenseDate'], {
    money: ['amount','baseAmount'], decimal: ['fxRate'], dates: ['expenseDate'],
    objectIds: ['paidByMemberId','accountId','categoryId','subcategoryId','receiptDocumentId'], objectIdArrays: ['beneficiaryMemberIds']
  }),
  bill_definitions: cfg(['name','provider','categoryId','expectedAmount','recurrence','dueDateRule','payerMemberId','accountId','autoPay','reminderRules'], ['name'], {
    money: ['expectedAmount'], objectIds: ['categoryId','payerMemberId','accountId']
  }),
  bill_instances: cfg(['billDefinitionId','period','expectedAmount','actualAmount','dueDate','paidDate','linkedExpenseId','sourceDocumentId','status'], ['billDefinitionId','period'], {
    money: ['expectedAmount','actualAmount'], objectIds: ['billDefinitionId','linkedExpenseId','sourceDocumentId'], payViaSpecial: true
  }),
  budgets: cfg(['name','method','recurrence','isActive','startDate'], ['name']),
  budget_periods: cfg(['budgetId','periodStart','periodEnd','plannedIncome','plannedExpense','actualIncome','actualExpense','status'], ['budgetId','periodStart','periodEnd'], {
    money: ['plannedIncome','plannedExpense','actualIncome','actualExpense'], dates: ['periodStart','periodEnd'], objectIds: ['budgetId'], serverOwnedAfterCreate: ['actualIncome','actualExpense']
  }),
  budget_buckets: cfg(['budgetPeriodId','categoryId','plannedAmount','actualAmount','carryForward','rolloverAmount'], ['budgetPeriodId'], {
    money: ['plannedAmount','actualAmount','rolloverAmount'], objectIds: ['budgetPeriodId','categoryId']
  }),
  allocation_plans: cfg(['name','totalAmount','planDate','status','items'], [], {
    money: ['totalAmount']
  }),
  loans: cfg(['name','loanType','lender','borrowerMemberIds','originalPrincipal','outstandingPrincipal','interestRate','interestType','emiAmount','tenureMonths','remainingMonths','startDate','expectedEndDate','dueDay','accountId'], ['name'], {
    money: ['originalPrincipal','outstandingPrincipal','emiAmount'], decimal: ['interestRate'], objectIds: ['accountId'], objectIdArrays: ['borrowerMemberIds']
  }),
  loan_payments: cfg(['loanId','paymentDate','totalAmount','principalComponent','interestComponent','extraPayment','outstandingAfter','paymentType','linkedTransactionId'], ['loanId','paymentDate'], {
    money: ['totalAmount','principalComponent','interestComponent','extraPayment','outstandingAfter'], dates: ['paymentDate'], objectIds: ['loanId','linkedTransactionId']
  }),
  credit_cards: cfg(['issuer','nickname','maskedCardNumber','creditLimit','outstanding','minimumDue','totalDue','statementDay','dueDay','interestRate'], [], {
    money: ['creditLimit','outstanding','minimumDue','totalDue'], decimal: ['interestRate'], maskFields: ['maskedCardNumber']
  }),
  investments: cfg(['investmentType','name','provider','accountReferenceMasked','totalContribution','currentValue','liquidity','maturityDate','expectedReturnAssumption','riskLabel','sipAmount','sipDay'], ['name'], {
    money: ['totalContribution','currentValue','sipAmount'], maskFields: ['accountReferenceMasked']
  }),
  investment_transactions: cfg(['investmentId','transactionDate','transactionType','amount','units','pricePerUnit','charges','linkedTransactionId'], ['investmentId','transactionDate'], {
    money: ['amount','charges'], decimal: ['units','pricePerUnit'], dates: ['transactionDate'], objectIds: ['investmentId','linkedTransactionId']
  }),
  assets: cfg(['name','assetType','purchaseValue','currentValue','purchaseDate','valuationDate','depreciationRate'], ['name'], {
    money: ['purchaseValue','currentValue']
  }),
  liabilities: cfg(['name','liabilityType','amount','counterparty','dueDate'], ['name'], {
    money: ['amount']
  }),
  goals: cfg(['name','goalType','ownerMemberIds','beneficiaryMemberIds','targetAmount','currentAmount','targetDate','priority','monthlyContribution','linkedInvestmentIds','inflationRate'], ['name'], {
    money: ['targetAmount','currentAmount','monthlyContribution'], objectIdArrays: ['ownerMemberIds','beneficiaryMemberIds','linkedInvestmentIds']
  }),
  goal_contributions: cfg(['goalId','contributionDate','amount','contributorMemberId','sourceType','linkedTransactionId'], ['goalId','contributionDate'], {
    money: ['amount'], dates: ['contributionDate'], objectIds: ['goalId','contributorMemberId','linkedTransactionId'], incrementGoalOnCreate: true
  }),
  emergency_fund_plans: cfg(['targetMonths','monthlyExpenseBasis','targetAmount','currentAmount','linkedAccountIds','status'], [], {
    money: ['monthlyExpenseBasis','targetAmount','currentAmount'], objectIdArrays: ['linkedAccountIds'], singleton: true
  }),
  insurance_policies: cfg(['policyType','provider','policyReferenceMasked','policyHolderMemberId','coveredMemberIds','coverageAmount','premiumAmount','premiumFrequency','startDate','expiryDate','renewalDate','documentId'], [], {
    money: ['coverageAmount','premiumAmount'], objectIds: ['policyHolderMemberId','documentId'], objectIdArrays: ['coveredMemberIds'], maskFields: ['policyReferenceMasked']
  }),
  decision_journal_entries: cfg(['decisionDate','title','context','decision','expectedOutcome','actualOutcome','reviewDate','linkedEntityType','linkedEntityId'], ['decisionDate','title'], {
    dates: ['decisionDate'], objectIds: ['linkedEntityId']
  }),
  life_events: cfg(['eventType','targetDate','affectedMemberIds','estimatedCost','planningStatus'], ['eventType'], {
    money: ['estimatedCost'], objectIdArrays: ['affectedMemberIds']
  }),
  documents: cfg(['documentType','filename','mimeType','storageType','storageReference','pageCount','fileSizeBytes','linkedEntityType','linkedEntityId','processingStatus','uploadedBy','uploadedAt','confirmedAt'], ['filename'], {
    objectIds: ['linkedEntityId','uploadedBy'], dates: ['uploadedAt','confirmedAt'], storageReference: true
  }),
  audit_findings: cfg(['dedupeKey','category','severity','title','expectedValue','actualValue','varianceAmount','variancePercent','rootCause','financialImpact','evidenceTransactionIds','recommendedActions','periodStart','detectedAt','acceptedVariance','snoozedUntil','dataQuality'], ['dedupeKey'], {
    money: ['expectedValue','actualValue','varianceAmount','financialImpact','acceptedVariance'], dates: ['periodStart','detectedAt','snoozedUntil'], objectIdArrays: ['evidenceTransactionIds'], upsertByDedupe: true
  }),
  notifications: cfg(['userId','dedupeKey','type','severity','title','body','actionRoute','entityType','entityId','readAt','expiresAt'], ['userId','type','title'], {
    objectIds: ['userId','entityId'], dates: ['readAt','expiresAt'], notificationDedupe: true
  }),
  financial_snapshots: cfg(['periodStart','periodEnd','totalIncome','totalExpense','totalSavings','netWorth','totalAssets','totalLiabilities','savingsRate','categoryBreakdown','computedAt'], ['periodStart'], {
    money: ['totalIncome','totalExpense','totalSavings','netWorth','totalAssets','totalLiabilities'], dates: ['periodStart','periodEnd','computedAt'], immutableWhenClosed: true
  })
};

const DEFAULT_SORT = {
  expenses: [{ field: 'expenseDate', dir: -1 }],
  transactions: [{ field: 'transactionDate', dir: -1 }],
  bill_instances: [{ field: 'dueDate', dir: 1 }],
  audit_findings: [{ field: 'detectedAt', dir: -1 }],
  notifications: [{ field: 'readAt', dir: 1 }, { field: 'createdAt', dir: -1 }]
};

const INTERNAL_COLLECTIONS = ['auth_credentials','auth_sessions','auth_rate_limits'];
const ALLOWED_UPLOAD_MIME = new Set([
  'application/pdf','image/jpeg','image/png','image/webp','text/csv','text/plain'
]);
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

module.exports = {
  GENERIC_COLLECTIONS, PERMISSION_ENTITY, ALL_PERMISSION_ENTITIES, ALL_PERMISSION_ACTIONS,
  SERVER_MANAGED_FIELDS, COLLECTION_CONFIG, DEFAULT_SORT, INTERNAL_COLLECTIONS,
  ALLOWED_UPLOAD_MIME, MAX_UPLOAD_BYTES
};
