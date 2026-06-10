// ESLint (flat config) del backend (PLAN_MEJORAS B3).
// Empieza pragmático: recommended de TS sin type-checking pesado, y `no-explicit-any` apagado
// hasta la Fase D (tipado estricto) para no frenar el plan con cientos de findings a la vez.
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'admin-panel/', 'coverage/'] },
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // se activa en Fase D (tipado estricto)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // Tests, scripts y JS sueltos de la raíz: JS plano con require().
    files: ['test/**/*.js', 'scripts/**/*.js', '*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
);
