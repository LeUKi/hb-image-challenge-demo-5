import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import hooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist/**', '.tanstack/**', '.wrangler/**', 'node_modules/**', 'src/routeTree.gen.ts', 'judge/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  { files: ['**/*.js', '**/*.mjs'], languageOptions: { globals: { fetch: 'readonly', URL: 'readonly', console: 'readonly', process: 'readonly' } } },
)
