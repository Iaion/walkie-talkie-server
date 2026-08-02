/**
 * test/unit/normalize.test.js
 * Unit test puro (sin server ni emulador) de la normalización antifraude.
 * Corre contra el código compilado (dist/), igual que el resto de la suite.
 */
const { normalizeEmail, normalizePhone, normalizeDocument } = require('../../dist/verification/normalize');

describe('normalize (antifraude)', () => {
  describe('normalizeEmail', () => {
    test('Gmail: ignora puntos y +tags del local part', () => {
      expect(normalizeEmail('Juan.Perez+spam@gmail.com')).toBe('juanperez@gmail.com');
      expect(normalizeEmail('j.u.a.n@googlemail.com')).toBe('juan@googlemail.com');
    });
    test('no-Gmail: baja a minúsculas y saca +tag, pero conserva los puntos', () => {
      expect(normalizeEmail('Juan.Perez+x@outlook.com')).toBe('juan.perez@outlook.com');
    });
    test('sin @ → devuelve el string en minúsculas', () => {
      expect(normalizeEmail('NoEsEmail')).toBe('noesemail');
    });
  });

  describe('normalizePhone', () => {
    test('deja solo dígitos', () => {
      expect(normalizePhone('+54 11 1234-5678')).toBe('541112345678');
      expect(normalizePhone('(011) 4444.5555')).toBe('01144445555');
    });
  });

  describe('normalizeDocument', () => {
    test('saca espacios, puntos y guiones; minúsculas', () => {
      expect(normalizeDocument('12.345.678')).toBe('12345678');
      expect(normalizeDocument('AB 12-34')).toBe('ab1234');
    });
  });
});
