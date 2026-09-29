import { fail } from './_auth.js';
export const maxDuration = 120;

// Census's public batch endpoint accepts up to 10,000 US addresses in a CSV.
function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
function parseCsv(input) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted && ch === '"' && input[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cell); if (row.some(Boolean)) rows.push(row);
      row = []; cell = '';
    } else cell += ch;
  }
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  return rows;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'POST required');
  const jobs = req.body?.jobs;
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > 500 || jobs.some(j => !Number.isInteger(j.page) || j.page < 1 || !j.street || !j.city || !/^\d{5}$/.test(j.zip) || j.state !== 'NY')) return fail(res, 400, 'Supply 1–500 NY addresses with five-digit ZIP codes');
  const csv = jobs.map(j => [j.page, j.street, j.city, j.state, j.zip].map(csvCell).join(',')).join('\r\n');
  const form = new FormData();
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
  form.append('benchmark', 'Public_AR_Current');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const upstream = await fetch('https://geocoding.geo.census.gov/geocoder/locations/addressbatch', { method: 'POST', body: form, signal: controller.signal });
    if (!upstream.ok) return fail(res, 502, `Census geocoder returned ${upstream.status}`);
    const rows = parseCsv(await upstream.text());
    const byPage = new Map(rows.map(r => {
      const pair = /\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?/.exec(r[5] || '');
      return [Number(r[0]), { match: r[2] || 'No_Match', matchedAddress: r[4] || '', lon: pair ? Number(pair[1]) : null, lat: pair ? Number(pair[2]) : null }];
    }));
    return res.json({ results: jobs.map(j => ({ page: j.page, ...(byPage.get(j.page) || { match: 'No_Match', matchedAddress: '', lon: null, lat: null }) })) });
  } catch { return fail(res, 502, 'Address matching failed or timed out. Retry in a moment.'); }
  finally { clearTimeout(timeout); }
}
