/**
 * image-utils.ts
 * Helpers de imagen portados del monolito (utils.isDataUrl / getMimeFromDataUrl / getBase64FromDataUrl).
 * Comportamiento idéntico para no romper la caracterización.
 */
export const isDataUrl = (str: unknown): boolean =>
  typeof str === 'string' && /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(str);

export const isHttpUrl = (str: unknown): boolean =>
  typeof str === 'string' && /^https?:\/\//i.test(str);

export const getMimeFromDataUrl = (dataUrl: string): string => {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(dataUrl || '');
  return match ? match[1] : 'image/jpeg';
};

export const getBase64FromDataUrl = (dataUrl: string): string | null => {
  const idx = (dataUrl || '').indexOf('base64,');
  return idx !== -1 ? dataUrl.substring(idx + 7) : null;
};
