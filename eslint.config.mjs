import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';

const readabilityRules = {
  curly: ['error', 'all'],
  'no-self-compare': 'error',
  'no-shadow': 'error',
  'id-length': ['error', { min: 2, properties: 'never' }],
  'lines-between-class-members': ['error', 'always'],
  'padding-line-between-statements': [
    'error',
    { blankLine: 'always', prev: '*', next: 'return' },
    { blankLine: 'always', prev: 'block-like', next: '*' },
    { blankLine: 'always', prev: '*', next: 'block-like' },
    { blankLine: 'always', prev: 'import', next: '*' },
    { blankLine: 'any', prev: 'import', next: 'import' },
  ],
  'one-var': ['error', 'never'],
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked,
      prettierConfig,
    ],
    languageOptions: {
      ecmaVersion: 2019,
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      ...readabilityRules,
      '@typescript-eslint/no-unused-expressions': 'off', // Breaks the linting
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  {
    files: ['tests/**/*.mjs', 'tests/types.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: readabilityRules,
  },
);
