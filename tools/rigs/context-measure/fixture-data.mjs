// I10a fixture content (integrated design 01a0d348 §7). Pure data, no I/O.
//
// Every A/B task needs ONE fact that sits only in one linked doc (its
// "needle"). The fact is placed DEEP in the body: after the first paragraph
// and past every heading, so a derived header (first paragraph ≤ 400 + the
// headings, within 600 chars — packages/server/src/headers/derive.ts) cannot
// carry it. A lane that gets the fact right had to open the doc. The one
// exception is `merchant`, whose fact is also in its AUTHORED header summary,
// to show what an authored header is worth on its own.

const INTRO = (topic) =>
  `This page is the working reference for ${topic} in ledger-lite, the small CSV ledger the finance tooling team maintains. ` +
  `It records what we agreed, why, and what is still open. Read it before changing the related code; the repo itself carries no product rules.`;

const FILLER = {
  background:
    'ledger-lite started as a script that summed a bank export. It grew a parser, then a handful of helpers that product asked for one at a time. ' +
    'Each helper was specified in a short page like this one, reviewed by the finance lead, and then implemented with a unit test. ' +
    'Several earlier drafts were discussed in chat and never written down, which is why this page exists.',
  scope:
    'In scope: the behaviour of the one exported helper this page is about, its inputs and outputs, and the error it raises. ' +
    'Out of scope: persistence, currency conversion, and the reporting UI, which are owned elsewhere.',
  history:
    'The first draft was written during the Q1 planning week. It was revised after the March review, when two edge cases turned up in real exports. ' +
    'The revision below is the one to implement; nothing earlier should be copied.',
  open:
    'Whether the helper should also accept a string amount is undecided. For now callers pass numbers. ' +
    'Localisation of messages is not needed yet.',
};

function needleBody(title, topic, rule) {
  return [
    `# ${title}`,
    '',
    INTRO(topic),
    '',
    '## Background',
    '',
    FILLER.background,
    '',
    '## Scope',
    '',
    FILLER.scope,
    '',
    '## History',
    '',
    FILLER.history,
    '',
    '## Rules',
    '',
    rule,
    '',
    '## Open questions',
    '',
    FILLER.open,
    '',
  ].join('\n');
}

/** The A/B tasks. `check` is evaluated by success.mjs against the lane's worktree. */
export const TASKS = [
  {
    key: 'fee',
    title: 'Add a transaction fee helper to ledger-lite',
    fn: 'fee',
    needle: {
      title: 'Transaction fees: spec v2',
      topic: 'transaction fees',
      rule:
        'The fee is 0.35% of the absolute amount, with a minimum fee of 0.40. The result is rounded to 2 decimals. ' +
        'A refund (negative amount) is charged on its absolute value, the same as a payment.',
      header: { whenToUse: 'When implementing or changing the fee helper', summary: 'The fee formula (rate, minimum, rounding) and how refunds are charged.' },
    },
    check: [
      ['fee(100)', 0.4],
      ['fee(1000)', 3.5],
      ['fee(-2000)', 7],
      ['fee(200)', 0.7],
    ],
  },
  {
    key: 'category',
    title: 'Add a category helper to ledger-lite',
    fn: 'categoryOf',
    needle: {
      title: 'Category mapping v3',
      topic: 'category mapping',
      rule:
        'Known categories are exactly: food, rent, travel, utilities. categoryOf(txn) returns the transaction\'s category when it is one of these. ' +
        'Anything else (an unknown value, an empty string, or a missing category) maps to the catch-all bucket `misc-7`.',
      header: { whenToUse: 'When mapping transaction categories', summary: 'The list of known categories and where unknown ones go.' },
    },
    check: [
      ["categoryOf({ category: 'food' })", 'food'],
      ["categoryOf({ category: 'Pets' })", 'misc-7'],
      ["categoryOf({ category: '' })", 'misc-7'],
      ['categoryOf({})', 'misc-7'],
    ],
  },
  {
    key: 'limit',
    title: 'Enforce the single-transaction limit in ledger-lite',
    fn: 'checkLimit',
    needle: {
      title: 'Transaction limits',
      topic: 'transaction limits',
      rule:
        'A single transaction may not exceed 9750.00 in absolute value; exactly 9750.00 is allowed. checkLimit(txn) returns nothing for an allowed transaction ' +
        'and throws an Error whose `code` property is the string `E_LIMIT_77` otherwise.',
      header: { whenToUse: 'When validating transaction size', summary: 'The per-transaction limit and the error code raised when it is exceeded.' },
    },
    check: [
      ['(() => { checkLimit({ amount: 9750 }); return "ok"; })()', 'ok'],
      ['(() => { try { checkLimit({ amount: -9750.01 }); return "no-throw"; } catch (e) { return e.code; } })()', 'E_LIMIT_77'],
    ],
  },
  {
    key: 'date',
    title: 'Parse export dates in ledger-lite',
    fn: 'parseDate',
    needle: {
      title: 'Bank export date format',
      topic: 'the bank export date format',
      rule:
        'The bank export writes dates as DD.MM.YYYY (day first, dot separated, zero padded). parseDate(s) converts that to an ISO date string YYYY-MM-DD. ' +
        'Example: 03.02.2026 is the 3rd of February 2026.',
      header: { whenToUse: 'When parsing dates from the bank export', summary: 'The date format the bank export uses and the format parseDate must return.' },
    },
    check: [
      ["parseDate('03.02.2026')", '2026-02-03'],
      ["parseDate('31.12.2025')", '2025-12-31'],
    ],
  },
  {
    key: 'csv',
    title: 'Add CSV export to ledger-lite',
    fn: 'toCsv',
    needle: {
      title: 'Accounting CSV export format',
      topic: 'the accounting CSV export',
      rule:
        'The accounting system imports semicolon-separated files. toCsv(txns) writes the header line `id;date;amount;category` (no merchant column), ' +
        'then one line per transaction in the same order, and ends with a trailing newline. Amounts are written with String(amount).',
      header: { whenToUse: 'When writing CSV for the accounting system', summary: 'The columns, delimiter and line endings the accounting import expects.' },
    },
    check: [
      ["toCsv([{ id: '1', date: '2026-01-02', amount: 10.5, category: 'food', merchant: 'ACME' }])", 'id;date;amount;category\n1;2026-01-02;10.5;food\n'],
    ],
  },
  {
    key: 'merchant',
    title: 'Normalize merchant names in ledger-lite',
    fn: 'normalizeMerchant',
    // The authored-header control: the fact is ALSO the header summary.
    headerCarriesFact: true,
    needle: {
      title: 'Merchant name normalization',
      topic: 'merchant name normalization',
      rule:
        'normalizeMerchant(s) trims whitespace, uppercases, then strips ONE trailing legal suffix, " LTD" or " GMBH", and trims again. ' +
        'Example: "  acme ltd " becomes "ACME".',
      header: {
        whenToUse: 'When normalizing merchant names',
        summary: 'normalizeMerchant(s): trim, uppercase, strip one trailing " LTD" or " GMBH", trim again ("  acme ltd " -> "ACME").',
      },
    },
    check: [
      ["normalizeMerchant('  acme ltd ')", 'ACME'],
      ["normalizeMerchant('Foo GmbH')", 'FOO'],
      ["normalizeMerchant('Bar')", 'BAR'],
    ],
  },
  {
    key: 'rounding',
    title: 'Add a rounded balance helper to ledger-lite',
    fn: 'roundedBalance',
    // The stress task: STRESS_LINKS docs, needle at STRESS_NEEDLE_AT, so the
    // referenceIndex sub-cap (8 KiB) has to trim around it.
    stress: true,
    needle: {
      title: 'Balance rounding policy',
      topic: 'balance rounding',
      rule:
        'roundedBalance(txns) sums the amounts and rounds the final sum ONCE to 2 decimals using round-half-to-even (banker\'s rounding): ' +
        'a value exactly halfway between two cents goes to the even cent. So 0.125 becomes 0.12 and 0.375 becomes 0.38.',
      header: { whenToUse: 'When rounding balances', summary: 'Which rounding mode balances use and when it is applied.' },
    },
    check: [
      ['roundedBalance([{ amount: 0.125 }])', 0.12],
      ['roundedBalance([{ amount: 0.375 }])', 0.38],
      ['roundedBalance([{ amount: 0.5 }, { amount: 0.125 }])', 0.62],
    ],
  },
];

export const STRESS_LINKS = 60;
/** 1-based link position of the stress needle: within the 32-link spawn read. */
export const STRESS_NEEDLE_AT = 30;

export function needleDoc(task) {
  return { title: task.needle.title, body: needleBody(task.needle.title, task.needle.topic, task.needle.rule), header: task.needle.header };
}

const DISTRACTOR_TOPICS = [
  'Onboarding notes for the ledger team', 'Release checklist', 'Incident review: duplicated March import', 'Glossary of ledger terms',
  'Code review guidelines', 'Test data policy', 'Branch naming', 'On-call handbook', 'Quarterly roadmap Q3', 'Quarterly roadmap Q4',
  'Security review notes', 'Dependency policy', 'Logging conventions', 'Performance budget', 'Accessibility of reports',
  'Data retention', 'Vendor list', 'Meeting notes: kickoff', 'Meeting notes: March review', 'Meeting notes: planning week',
  'Architecture overview', 'Deployment runbook', 'Backup and restore', 'Support escalation path', 'Customer FAQ draft',
  'Import troubleshooting', 'Error message style guide', 'Changelog conventions', 'Versioning policy', 'Localisation plan',
  'Reporting UI wireframes', 'Finance lead contacts', 'Audit trail requirements', 'Feature flag policy', 'Sandbox environment setup',
  'Postmortem template', 'Decision log', 'Team rituals', 'Hiring rubric', 'Offboarding checklist',
  'Budget tracking', 'Tax season prep', 'Reconciliation notes', 'Bank API evaluation', 'Old parser design (retired)',
  'Spreadsheet macros (retired)', 'Metrics we track', 'User interviews summary', 'Competitor notes', 'Pricing experiments',
  'Training plan', 'Documentation map', 'Style guide for docs', 'Keyboard shortcuts in the report UI', 'Accessibility audit',
  'Data model sketch', 'Integration test plan', 'Load test results', 'Cost review', 'Retrospective notes',
];

/** Plausible, non-conflicting docs with no ledger-helper rules in them. */
export function distractorDocs(n) {
  return DISTRACTOR_TOPICS.slice(0, n).map((title) => ({
    title,
    body: [
      `# ${title}`,
      '',
      `Notes on ${title.toLowerCase()} for the ledger-lite team. This page is informational and does not define helper behaviour.`,
      '',
      '## Summary',
      '',
      FILLER.background,
      '',
      '## Details',
      '',
      FILLER.history + ' ' + FILLER.open,
      '',
    ].join('\n'),
  }));
}

/** §7.1: ~10 equipped skills. Generic on purpose: none carries a task's fact. */
export const SKILLS = [
  ['csv-hygiene', 'Checklist for touching CSV parsing or writing: header lines, trailing newlines, BOMs, delimiters.'],
  ['test-first', 'Write the failing node --test case before the implementation, then make it pass.'],
  ['commit-style', 'How to word and scope commits in small repos: one change per commit, imperative subject.'],
  ['error-codes', 'How helpers report failure: throw an Error that carries a string `code` property.'],
  ['changelog-entry', 'Add a CHANGELOG line for every user-visible helper you add or change.'],
  ['date-handling', 'Keep dates as ISO strings internally; convert only at the edges.'],
  ['review-checklist', 'Self-review before closing out: tests, exports, naming, no stray logs.'],
  ['perf-notes', 'When a helper runs over a whole export, keep it single-pass and allocation-light.'],
  ['naming-conventions', 'Exported helpers are camelCase verbs or nouns; files are kebab-case.'],
  ['release-notes', 'How to draft release notes from merged changes.'],
];

/** §7.1: ~8 remembered memories. True, useful, and none carries a task's fact. */
export const MEMORIES = [
  ['ledger-lite tests run with node --test; there is no jest or vitest in the repo.', 'test runner', 'package.json scripts.test'],
  ['ledger-lite is plain ESM JavaScript (type: module); no build step and no TypeScript.', 'language and module system', 'package.json type field'],
  ['Every exported helper lives in src/ledger.js; tests live in test/.', 'repo layout', 'repo tree'],
  ['Amounts in ledger-lite are JavaScript numbers, not strings or cents integers.', 'amount representation', 'parseCsv converts with Number()'],
  ['The CSV import header is id,date,amount,category,merchant.', 'import format', 'parseCsv reads the header line'],
  ['Product rules for helpers are in tm8 docs linked to each task, never in the repo.', 'where rules live', 'README says so'],
  ['The finance lead reviews helper behaviour, so quote the spec doc in the closeout.', 'review process', 'team practice'],
  ['Keep ledger-lite dependency-free; do not add npm packages.', 'dependencies', 'team practice'],
];

// ISO dates and plain merchant names: the attached file must not leak a needle's fact.
export const SAMPLE_CSV =
  'id,date,amount,category,merchant\n1,2026-01-02,10.50,food,Corner Deli\n2,2026-01-03,-2.50,food,Corner Deli\n3,2026-01-05,950.00,rent,Harbor Flats\n';
