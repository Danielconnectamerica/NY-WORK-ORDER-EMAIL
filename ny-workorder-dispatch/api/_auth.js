import { timingSafeEqual } from 'node:crypto';

export function authorized(req) {
  const expected = process.env.DISPATCH_PASSWORD;
  const actual = req.headers['x-dispatch-password'];
  if (!expected || typeof actual !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function fail(res, status, message) {
  return res.status(status).json({ error: message });
}
