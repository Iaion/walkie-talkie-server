import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// En `build` (producción) el panel lo sirve el backend bajo /panel → los assets deben
// referenciar /panel/... (base). En `dev` (npm run dev) corre suelto en la raíz.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/panel/' : '/',
  plugins: [react()],
  server: { port: 5173 },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
}));
