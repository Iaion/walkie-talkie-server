/**
 * jest.config.js
 * Configuración de los tests de caracterización (Fase 0.5).
 * - globalSetup levanta el monolito apuntado a los emuladores; globalTeardown lo apaga.
 * - Los tests corren en serie (--runInBand desde el script) porque comparten un único
 *   server + estado del emulador.
 */
module.exports = {
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/setup/global-setup.js',
  globalTeardown: '<rootDir>/test/setup/global-teardown.js',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  testTimeout: 20000,
};
