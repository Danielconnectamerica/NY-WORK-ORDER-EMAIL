import { authorized, fail } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'POST required');
  if (!authorized(req)) return fail(res, 401, 'Dispatcher password is missing or incorrect');
  const url = process.env.POWER_AUTOMATE_URL;
  const domain = process.env.ALLOWED_EMAIL_DOMAIN?.toLowerCase();
  if (!url || !domain) return fail(res, 503, 'Email flow and recipient domain must be configured');
  const { email, filename, contentBase64, subject, body, dispatchId, orderIds } = req.body || {};
  if (typeof email !== 'string' || !email.toLowerCase().endsWith(`@${domain}`) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Installer email is outside the allowed domain');
  if (!/^[-\w]+\.pdf$/.test(filename || '') || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64 || '') || contentBase64.length > 3_500_000 || !subject || !body || !dispatchId || !Array.isArray(orderIds) || orderIds.length < 1 || orderIds.length > 16) return fail(res, 400, 'Invalid packet or packet exceeds email size limit');
  // A server-side secret never reaches the browser. Configure the flow to deduplicate dispatchId + email.
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
    let response;
    try { response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, filename, contentBase64, subject, body, dispatchId, orderIds }), signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (!response.ok) return fail(res, 502, `Email flow returned ${response.status}; check flow run history before retrying`);
    return res.json({ accepted: true });
  } catch { return fail(res, 502, 'Email flow did not confirm receipt; check flow run history before retrying'); }
}
