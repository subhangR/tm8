// ESLint 9 flat config for apps/mobile (DoD D3; laws L-A and L-C; s-lld §2,
// §13). `bun run lint` runs it with --max-warnings=0, and
// test/no-kind-literals.test.ts proves each rule fires where it should and
// stays quiet where it should not.
//
// A flat config does not merge one rule's options across blocks: the last
// block that sets `no-restricted-syntax` for a file wins. So the blocks below
// go from general to specific, and each sets the complete list for its files.
import js from '@eslint/js';
import { CORE_KIND_INFO } from '@tm8/contract/kind-info';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// L-A: the 33 core kinds, read from the contract. CORE_KIND_INFO is a
// Record<CoreEntityKind, …>, so a 34th kind is banned the day it exists.
const CORE_KINDS = Object.keys(CORE_KIND_INFO);
if (CORE_KINDS.length === 0 || !CORE_KINDS.every((kind) => /^[a-z_]+$/.test(kind))) {
  throw new Error('eslint.config.mjs: unexpected core kind names from @tm8/contract/kind-info');
}
const KIND = CORE_KINDS.join('|');
const L_A = 'L-A: no kind literal outside src/registry. Read the kind through configFor(kind) and registry data.';

const kindRules = [
  { selector: `Literal[value=/^(${KIND})$/]`, message: L_A },
  { selector: `TemplateLiteral[expressions.length=0] > TemplateElement[value.raw=/^(${KIND})$/]`, message: L_A },
  {
    // `kind === <literal>` for any literal, custom kinds (c:*) included.
    selector:
      'BinaryExpression[operator=/^[!=]==?$/]' +
      ':matches([left.name="kind"], [left.property.name="kind"], [left.expression.property.name="kind"], [right.name="kind"], [right.property.name="kind"], [right.expression.property.name="kind"])' +
      ':matches([left.type="Literal"], [right.type="Literal"], [left.type="TemplateLiteral"], [right.type="TemplateLiteral"])',
    message: `${L_A} No \`kind ===\` branch: add a registry field instead.`,
  },
];

// L-C: colours come from theme tokens only; src/theme/tokens.gen.ts is generated
// (t-p0-theme). A string that is a whole #rgb/#rgba, or contains a #rrggbb or
// #rrggbbaa, or an rgb()/hsl() call. Shorter hex inside longer text stays legal,
// so "PR #1383" is not a colour.
const L_C = 'L-C: no raw colour outside src/theme/tokens.gen.ts. Use a theme token.';
const COLOUR = '^#[0-9a-fA-F]{3,4}$|#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z])|(?:^|[^a-zA-Z])(?:rgba?|hsla?)\\(';
const colourRules = [
  { selector: `Literal[value=/${COLOUR}/i]`, message: L_C },
  { selector: `TemplateElement[value.raw=/${COLOUR}/i]`, message: L_C },
];

// App code: screens, the spine, state, net and the WebView page. The registry
// is the one folder that may name a kind, and fixtures (the BRIEF §5 world) may too.
const APP_CODE = ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}', 'terminal-web/**/*.{ts,tsx}'];
const MAY_NAME_KINDS = ['src/registry/**/*.{ts,tsx}', '**/__fixtures__/**/*.{ts,tsx}', '**/fixtures/**/*.{ts,tsx}', '**/*.fixture.{ts,tsx}'];
const TOKENS = 'src/theme/tokens.gen.ts';

const DOM = 'D3: no DOM in the app. React Native has no window, document or localStorage.';
const RN_WEB_ONLY = `${DOM} react-dom is installed for the RN-web QA harness only.`;

export default defineConfig([
  globalIgnores(['node_modules/', 'dist-*/', '.expo/', 'expo-env.d.ts', 'assets/', 'android/', 'ios/', 'coverage/']),
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  { files: ['**/*.{ts,tsx,mts,cts}'], extends: [tseslint.configs.recommended] },
  {
    // Node tooling: config files and scripts.
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly', process: 'readonly', console: 'readonly' },
    },
  },
  { files: ['**/*.mjs'], languageOptions: { sourceType: 'module' } },

  // no-restricted-syntax, general to specific (see the note at the top).
  { files: ['**/*.{ts,tsx,mts,cts,js,cjs,mjs}'], rules: { 'no-restricted-syntax': ['error', ...colourRules] } },
  { files: APP_CODE, rules: { 'no-restricted-syntax': ['error', ...colourRules, ...kindRules] } },
  { files: MAY_NAME_KINDS, rules: { 'no-restricted-syntax': ['error', ...colourRules] } },
  { files: [TOKENS], rules: { 'no-restricted-syntax': ['error', ...kindRules] } },

  {
    // D3: React Native code never touches the DOM. terminal-web/ is the WebView
    // page, a browser by design, so it is not in this block.
    files: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: DOM },
        { name: 'document', message: DOM },
        { name: 'localStorage', message: `${DOM} Tokens live in SecureStore (L-H), data in SQLite.` },
        { name: 'sessionStorage', message: DOM },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tm8/contract',
              message: 's-lld §13: import @tm8/contract by subpath (@tm8/contract/<module>), never the barrel (66 modules, a 797 KB chunk).',
            },
            { name: 'react-dom', message: RN_WEB_ONLY },
          ],
          patterns: [
            { group: ['react-dom/**'], message: RN_WEB_ONLY },
            { group: ['tm8-ui', 'tm8-ui/**', '**/packages/tm8-ui/**'], message: 's-lld §2: tm8-ui draws the DOM. Shared code comes from @tm8/client-core.' },
            {
              group: ['@tm8/*/src', '@tm8/*/src/**', '@tm8/*/dist', '@tm8/*/dist/**'],
              message: 's-lld §2: import a workspace package by its exports subpath, never its src or dist paths.',
            },
          ],
        },
      ],
    },
  },
]);
