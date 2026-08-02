/**
 * jest.config.js
 * Configuración de los tests de caracterización (Fase 0.5).
 * - Cada archivo de test levanta su propio server (beforeAll/afterAll via test/setup/server.js)
 *   para tener estado EN MEMORIA limpio por suite.
 * - Corren en serie (--runInBand desde el script): comparten el puerto 8080 y el emulador.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  testTimeout: 30000,
};
