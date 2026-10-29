import tseslint from 'typescript-eslint';

/**
 * @tm8/client-core runs in two places: the web app (Vite) and the phone app
 * (Hermes). Nothing here may touch the DOM or React (DoD D3, s-lld §2), and
 * nothing may reach back into tm8-ui. The type layer enforces the first half
 * too (lib ES2022, no DOM); this config names the globals and imports, so the
 * reason reads in words.
 */
const DOM_GLOBALS = [
  'window',
  'document',
  'history',
  'location',
  'localStorage',
  'sessionStorage',
  'navigator',
  'indexedDB',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'HTMLElement',
  'Element',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
];

const NO_DOM = 'client-core runs under Hermes too: no DOM. Keep it in tm8-ui, or pass the value in.';
const NO_REACT = 'client-core is React-free: hooks and components stay in each app.';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['**/*.ts', '**/*.js'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-restricted-globals': ['error', ...DOM_GLOBALS.map((name) => ({ name, message: NO_DOM }))],
      'no-restricted-syntax': [
        'error',
        {
          selector: `MemberExpression[object.name='globalThis'][property.name=/^(${DOM_GLOBALS.join('|')})$/]`,
          message: NO_DOM,
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: NO_REACT },
            { name: 'react-dom', message: NO_REACT },
            { name: 'react-native', message: NO_REACT },
          ],
          patterns: [
            { group: ['react/*', 'react-dom/*', 'react-native/*', '@testing-library/*'], message: NO_REACT },
            { group: ['tm8-ui', 'tm8-ui/*', '**/tm8-ui/**'], message: 'client-core never imports tm8-ui; tm8-ui imports client-core.' },
          ],
        },
      ],
    },
  },
];
