/**
 * test/unit/ownership.test.js
 * Unit test puro de la autorización por-usuario (assertSelf): un usuario solo opera sobre lo suyo.
 */
const { assertSelf } = require('../../dist/common/ownership');

describe('assertSelf (autorización por-usuario)', () => {
  test('mismo uid que el recurso → no lanza', () => {
    expect(() => assertSelf({ user: { uid: 'U1' } }, 'U1')).not.toThrow();
  });

  test('uid distinto → lanza (403)', () => {
    expect(() => assertSelf({ user: { uid: 'U1' } }, 'U2')).toThrow();
  });

  test('admin → puede operar sobre cualquiera', () => {
    expect(() => assertSelf({ user: { uid: 'U1', role: 'admin' } }, 'U2')).not.toThrow();
  });

  test('target ausente → lanza', () => {
    expect(() => assertSelf({ user: { uid: 'U1' } }, undefined)).toThrow();
  });
});
