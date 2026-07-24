import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

// Constant-time string comparison. Pads the shorter buffer so length alone
// never leaks through timing, then compares.
export function keysMatch(presented, expected) {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(String(expected ?? ''));
  const len = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(len);
  const paddedB = Buffer.alloc(len);
  a.copy(paddedA);
  b.copy(paddedB);
  return a.length === b.length && nodeTimingSafeEqual(paddedA, paddedB);
}
