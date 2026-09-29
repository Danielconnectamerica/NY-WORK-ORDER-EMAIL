import nyZipCentroids from './ny-zip-centroids.json';

export function appointmentDate(job) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/.exec((job.appointment || '').trim());
  if (!match) return null;
  const [, rawMonth, rawDay, rawYear] = match;
  const month = Number(rawMonth), day = Number(rawDay), year = Number(rawYear);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return `${rawYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function groupByAppointmentDate(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const dateKey = appointmentDate(job);
    if (!dateKey) throw new Error(`WO ${job.id || job.page}: enter a valid Appointment Date (M/D/YYYY) before routing`);
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(job);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([dateKey, dateJobs]) => ({ dateKey, jobs: dateJobs }));
}

export function partitionForDispatch(jobs, dispatchDate) {
  const selected = [], other = [];
  for (const job of jobs) (dispatchDate && appointmentDate(job) === dispatchDate ? selected : other).push(job);
  return { selected, other };
}

export function buildDateRoutes(jobs, installerCount, matrix, { spreadShort = false } = {}) {
  if (!Number.isInteger(installerCount) || installerCount < 1 || installerCount > 100) throw new Error('Add at least one installer');
  if (matrix.length !== jobs.length || matrix.some(row => row.length !== jobs.length || row.some(v => !Number.isFinite(v) || v < 0))) throw new Error('Invalid travel matrix');
  const positions = new Map(jobs.map((job, index) => [job, index]));
  return groupByAppointmentDate(jobs).flatMap(({ dateKey, jobs: dateJobs }) => {
    if (dateJobs.length > 16 * installerCount) throw new Error(`${dateKey}: ${dateJobs.length} work orders exceed ${installerCount} installers at 16 stops each. Add installers for this date.`);
    const count = spreadShort ? Math.min(installerCount, dateJobs.length) : Math.ceil(dateJobs.length / 16);
    const indices = dateJobs.map(job => positions.get(job));
    const subset = indices.map(i => indices.map(j => matrix[i][j]));
    return optimize(dateJobs, count, subset, { allowShort: true }).map((route, installerIndex) => ({ ...route, dateKey, installerIndex }));
  }).map((route, index) => ({ ...route, number: index + 1 }));
}

export function feasibleCounts(n, count, min = 14, max = 16) {
  if (!Number.isInteger(count) || count < 1 || count > 100) return null;
  if (n < min * count || n > max * count) return null;
  const result = Array(count).fill(min);
  for (let remaining = n - count * min, i = 0; remaining; i = (i + 1) % count) {
    if (result[i] < max) { result[i]++; remaining--; }
  }
  return result;
}

export function distanceSeconds(a, b) {
  const rad = Math.PI / 180;
  const dLat = (a.lat - b.lat) * rad, dLon = (a.lon - b.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))) / 25 * 3600;
}

export function approximateMatrix(jobs) {
  return jobs.map(a => jobs.map(b => distanceSeconds(a.geo, b.geo)));
}

export function zipEstimate(jobs, zip) {
  const anchors = jobs.filter(j => j.zip === zip && j.geo?.match === 'Match' && Number.isFinite(j.geo.lat) && Number.isFinite(j.geo.lon));
  if (!anchors.length) {
    const area = nyZipCentroids[zip];
    if (!area) return null;
    return {
      match: 'Zip_Estimate',
      matchedAddress: `Approximate ZIP ${zip} area (offline centroid)`,
      lat: area[0],
      lon: area[1]
    };
  }
  return {
    match: 'Zip_Estimate',
    matchedAddress: `Approximate ${zip} area (from ${anchors.length} verified stop${anchors.length === 1 ? '' : 's'})`,
    lat: anchors.reduce((sum, j) => sum + j.geo.lat, 0) / anchors.length,
    lon: anchors.reduce((sum, j) => sum + j.geo.lon, 0) / anchors.length
  };
}

function cost(route, matrix) {
  return route.slice(1).reduce((sum, id, i) => sum + matrix[route[i]][id], 0);
}

function orderRoute(indices, matrix) {
  if (indices.length < 3) return indices;
  // No installer start address has been supplied: find a short open path.
  let best = null;
  for (const start of indices) {
    const rest = new Set(indices); rest.delete(start);
    const route = [start];
    while (rest.size) {
      let next = null, score = Infinity;
      for (const id of rest) if (matrix[route.at(-1)][id] < score) { score = matrix[route.at(-1)][id]; next = id; }
      route.push(next); rest.delete(next);
    }
    if (!best || cost(route, matrix) < cost(best, matrix)) best = route;
  }
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) for (let j = i + 1; j < best.length; j++) {
      const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
      if (cost(candidate, matrix) + 0.01 < cost(best, matrix)) { best = candidate; improved = true; }
    }
    if (!improved) break;
  }
  return best;
}

export function optimize(jobs, installerCount, matrix, { allowShort = false } = {}) {
  const n = jobs.length;
  const counts = feasibleCounts(n, installerCount) || (allowShort && n <= 16 * installerCount && n >= installerCount ? Array.from({ length: installerCount }, (_, i) => Math.floor(n / installerCount) + (i < n % installerCount ? 1 : 0)) : null);
  if (!counts) throw new Error(`${n} jobs cannot fill ${installerCount} routes with 14–16 stops each`);
  if (matrix.length !== n || matrix.some(row => row.length !== n || row.some(v => !Number.isFinite(v) || v < 0))) throw new Error('Invalid travel matrix');
  // Spread seeds apart; assign each remaining job to its closest route, observing hard capacities.
  const seeds = [0];
  while (seeds.length < installerCount) {
    let next = -1, furthest = -1;
    for (let i = 0; i < n; i++) if (!seeds.includes(i)) {
      const nearest = Math.min(...seeds.map(s => matrix[s][i] + matrix[i][s]));
      if (nearest > furthest) { furthest = nearest; next = i; }
    }
    seeds.push(next);
  }
  const groups = seeds.map(s => [s]);
  const remaining = new Set(Array.from({ length: n }, (_, i) => i).filter(i => !seeds.includes(i)));
  while (remaining.size) {
    let choice = null;
    for (const i of remaining) for (let r = 0; r < groups.length; r++) {
      if (groups[r].length >= counts[r]) continue;
      const score = Math.min(...groups[r].map(j => matrix[i][j] + matrix[j][i]));
      if (!choice || score < choice.score) choice = { i, r, score };
    }
    groups[choice.r].push(choice.i); remaining.delete(choice.i);
  }
  const ordered = groups.map(g => orderRoute(g, matrix));
  return ordered.map((indices, i) => ({ number: i + 1, jobs: indices.map(index => jobs[index]), travelMinutes: Math.round(cost(indices, matrix) / 60) }));
}
