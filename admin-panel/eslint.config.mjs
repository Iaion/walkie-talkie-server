// ESLint (flat config) del panel admin (PLAN_MEJORAS B3).
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off', // api.ts se tipa en Fase G
      // El fetch-on-mount con setState en useEffect se reemplaza por hooks de datos en Fase G.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
);
