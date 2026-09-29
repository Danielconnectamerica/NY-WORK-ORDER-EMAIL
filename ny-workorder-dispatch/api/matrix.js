import { authorized, fail } from './_auth.js';
export const maxDuration = 300;

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'POST required');
  if (!authorized(req)) return fail(res, 401, 'Dispatcher password is missing or incorrect');
  const base = process.env.OSRM_URL;
  if (!base) return fail(res, 503, 'No road routing service configured');
  const points = req.body?.points;
  if (!Array.isArray(points) || points.length < 2 || points.length > 200 || points.some(p => !Number.isFinite(p.lon) || !Number.isFinite(p.lat) || p.lon < -80 || p.lon > -70 || p.lat < 39 || p.lat > 45)) return fail(res, 400, 'Road matrix supports 2–200 NY addresses per run');
  const matrix = Array.from({ length: points.length }, () => Array(points.length).fill(null));
  const size = 35;
  try {
    for (let a = 0; a < points.length; a += size) {
      for (let b = 0; b < points.length; b += size) {
        const src = points.slice(a, a + size), dst = points.slice(b, b + size);
        const combined = [...src, ...dst];
        const url = new URL(`${base.replace(/\/$/, '')}/table/v1/driving/${combined.map(p => `${p.lon},${p.lat}`).join(';')}`);
        url.searchParams.set('sources', src.map((_, i) => i).join(';'));
        url.searchParams.set('destinations', dst.map((_, i) => i + src.length).join(';'));
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
        let response;
        try { response = await fetch(url, { signal: controller.signal }); } finally { clearTimeout(timer); }
        if (!response.ok) return fail(res, 502, `Road routing returned ${response.status}`);
        const data = await response.json();
        if (data.code !== 'Ok' || data.durations?.length !== src.length || data.durations.some(row => row.length !== dst.length || row.some(x => x === null))) return fail(res, 502, 'Road routing has an unreachable stop');
        data.durations.forEach((row, i) => row.forEach((seconds, j) => { matrix[a + i][b + j] = seconds; }));
      }
    }
    return res.json({ matrix });
  } catch { return fail(res, 502, 'Road routing failed or timed out. Use approximate mode or retry.'); }
}
