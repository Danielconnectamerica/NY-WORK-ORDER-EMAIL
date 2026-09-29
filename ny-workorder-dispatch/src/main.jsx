import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readPdfs, packet, safeStreet, validateBatchJobs } from './pdf.js';
import { approximateMatrix, optimize, feasibleCounts, zipEstimate } from './routing.js';
import './style.css';

function App() {
  const [password, setPassword] = useState('');
  const [files, setFiles] = useState([]);
  const [sources, setSources] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [excludedJobs, setExcludedJobs] = useState([]);
  const [installers, setInstallers] = useState([{ name: '', email: '' }]);
  const [routes, setRoutes] = useState([]);
  const [mode, setMode] = useState('approximate');
  const [pilot, setPilot] = useState(false);
  const [status, setStatus] = useState('Choose one or more PDFs to start.');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState({});
  const [dispatchId, setDispatchId] = useState('');

  const hasErrors = jobs.some(j => j.errors.length);
  const geoReady = jobs.length && jobs.every(j => j.geo && Number.isFinite(j.geo.lat) && Number.isFinite(j.geo.lon) && ['Match', 'Zip_Estimate', 'Manual'].includes(j.geo.match));
  const counts = feasibleCounts(jobs.length, installers.length);
  const capacityReady = !!counts || (pilot && jobs.length >= installers.length && jobs.length <= 16 * installers.length);
  const installerReady = installers.every(x => x.name.trim());
  const invalidate = () => { setRoutes([]); setSent({}); };
  async function call(path, body) {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dispatch-password': password }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `${path} failed`);
    return data;
  }
  async function upload(input) {
    const selected = Array.from(input || []);
    if (!selected.length) return;
    setBusy(true); setJobs([]); setExcludedJobs([]); setSources([]); setFiles(selected); invalidate();
    try {
      setStatus('Reading PDFs in this browser…');
      const result = await readPdfs(selected, (name, page, total, number, count) => setStatus(`Reading PDF ${number} of ${count}: ${name}, page ${page} of ${total}…`));
      setSources(result.sources); setJobs(result.jobs);
      setStatus(`${result.jobs.length} work orders found across ${selected.length} PDF${selected.length === 1 ? '' : 's'}${result.skippedPages.length ? `; skipped blank ${result.skippedPages.join(', ')}` : ''}. Review extracted fields, then match addresses.`);
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }
  function clearBatch() {
    setFiles([]); setSources([]); setJobs([]); setExcludedJobs([]); invalidate();
    setStatus('Choose one or more PDFs to start.');
  }
  function removeFile(index) {
    const remaining = files.filter((_, i) => i !== index);
    if (remaining.length) upload(remaining);
    else clearBatch();
  }
  function editJob(page, key, value) {
    setJobs(old => validateBatchJobs(old.map(j => j.page === page ? { ...j, [key]: value, geo: null } : j)));
    invalidate();
  }
  function excludeJob(page) {
    const job = jobs.find(j => j.page === page);
    if (!job || anySent) return;
    setExcludedJobs(old => [...old, job]);
    setJobs(old => validateBatchJobs(old.filter(j => j.page !== page)));
    invalidate();
    setStatus(`WO ${job.id || '(missing number)'} removed from this batch. Restore it below if needed.`);
  }
  function restoreJob(page) {
    const job = excludedJobs.find(j => j.page === page);
    if (!job || anySent) return;
    setExcludedJobs(old => old.filter(j => j.page !== page));
    setJobs(old => validateBatchJobs([...old, job].sort((a, b) => a.page - b.page)));
    invalidate();
    setStatus(`WO ${job.id || '(missing number)'} restored to this batch.`);
  }
  async function geocode(pages = null) {
    setBusy(true); invalidate();
    try {
      const selected = pages ? jobs.filter(j => pages.includes(j.page)) : jobs;
      setStatus(`Matching ${selected.length === 1 ? 'address' : `${selected.length} addresses`} with the U.S. Census geocoder…`);
      const { results } = await call('geocode', { jobs: selected.map(j => ({ page: j.page, street: safeStreet(j.street), city: j.city, state: j.state, zip: j.zip })) });
      const byPage = new Map(results.map(x => [x.page, x]));
      setJobs(old => old.map(j => byPage.has(j.page) ? { ...j, geo: byPage.get(j.page) } : j));
      const matched = results.filter(x => x.match === 'Match' && Number.isFinite(x.lat) && Number.isFinite(x.lon)).length;
      setStatus(`${matched} of ${selected.length} checked address${selected.length === 1 ? '' : 'es'} matched. Edit an unmatched row and use Check this address.`);
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }
  function useZipArea(page) {
    const target = jobs.find(j => j.page === page);
    const estimate = zipEstimate(jobs, target.zip);
    if (!estimate) return;
    setJobs(old => old.map(j => j.page === page ? { ...j, geo: estimate } : j));
    invalidate();
    setStatus(`Page ${page} uses an approximate ZIP-area location. Review its installer and stop order before dispatch.`);
  }
  function setManualPin(page) {
    const job = jobs.find(j => j.page === page);
    const lat = Number(job.manualLat), lon = Number(job.manualLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 40.4 || lat > 45.1 || lon < -80 || lon > -71.7 || !String(job.manualLat).trim() || !String(job.manualLon).trim()) {
      setStatus(`Page ${page}: enter a latitude and longitude within New York State.`); return;
    }
    setJobs(old => old.map(j => j.page === page ? { ...j, geo: { match: 'Manual', matchedAddress: 'Pin placed by dispatch; address is unverified', lat, lon } } : j));
    invalidate(); setStatus(`Page ${page} uses a dispatch pin. Review the actual service address and route assignment before sending.`);
  }
  async function buildRoutes() {
    setBusy(true);
    try {
      setStatus('Building routes…');
      let matrix = approximateMatrix(jobs);
      if (mode === 'roads') matrix = (await call('matrix', { points: jobs.map(j => ({ lon: j.geo.lon, lat: j.geo.lat })) })).matrix;
      const next = optimize(jobs, installers.length, matrix, { allowShort: pilot });
      setRoutes(next); setSent({}); setDispatchId(globalThis.crypto.randomUUID());
      setStatus(`${next.length} routes ready. Review every assignment before sending.`);
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }
  function download(data, name) {
    const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const filename = (route, installer) => {
    const date = route.jobs[0]?.appointment.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    const day = date ? `${date[3]}-${date[1].padStart(2, '0')}-${date[2].padStart(2, '0')}` : new Date().toISOString().slice(0, 10);
    return `${installer.name.trim().replace(/[^\w-]+/g, '_')}_${day}_${route.jobs.length}_WorkOrders.pdf`;
  };
  function mapLinks(route) {
    const places = route.jobs.map(j => `${safeStreet(j.street)}, ${j.city}, ${j.state} ${j.zip}`);
    const links = [];
    for (let i = 0; i < places.length - 1; i += 7) {
      const chunk = places.slice(i, Math.min(i + 8, places.length));
      const params = new URLSearchParams({ api: '1', origin: chunk[0], destination: chunk.at(-1) });
      if (chunk.length > 2) params.set('waypoints', chunk.slice(1, -1).join('|'));
      links.push(`https://www.google.com/maps/dir/?${params}`);
    }
    return links;
  }
  const anySent = Object.values(sent).some(Boolean);
  function changeRouteJob(routeIndex, jobIndex, targetIndex) {
    if (anySent) return;
    setRoutes(old => {
      const next = old.map(r => ({ ...r, jobs: [...r.jobs] }));
      if (targetIndex === routeIndex) return old;
      if (next[targetIndex].jobs.length >= 16 || next[routeIndex].jobs.length <= 1) return old;
      const [job] = next[routeIndex].jobs.splice(jobIndex, 1);
      next[targetIndex].jobs.push({ ...job, reviewed: false });
      next[routeIndex].travelMinutes = null;
      next[targetIndex].travelMinutes = null;
      return next;
    });
    setStatus('Assignment changed. Review the destination route and directions before dispatch.');
  }
  function moveStop(routeIndex, jobIndex, direction) {
    if (anySent) return;
    setRoutes(old => old.map((r, i) => {
      if (i !== routeIndex || jobIndex + direction < 0 || jobIndex + direction >= r.jobs.length) return r;
      const list = [...r.jobs]; [list[jobIndex], list[jobIndex + direction]] = [list[jobIndex + direction], list[jobIndex]];
      list[jobIndex] = { ...list[jobIndex], reviewed: false };
      list[jobIndex + direction] = { ...list[jobIndex + direction], reviewed: false };
      return { ...r, jobs: list, travelMinutes: null };
    }));
  }
  function reviewStop(routeIndex, page, checked) {
    if (anySent) return;
    setRoutes(old => old.map((r, i) => i === routeIndex ? { ...r, jobs: r.jobs.map(j => j.page === page ? { ...j, reviewed: checked } : j) } : r));
  }
  async function sendRoute(route, installer, i) {
    if (route.jobs.some(j => j.geo?.match !== 'Match' && !j.reviewed)) { setStatus(`Route ${i + 1}: review each approximate or manual stop before emailing.`); return; }
    setBusy(true);
    try {
      const pdf = await packet(sources, route);
      const base64 = btoa(Array.from({ length: Math.ceil(pdf.length / 8192) }, (_, k) => String.fromCharCode(...pdf.slice(k * 8192, (k + 1) * 8192))).join(''));
      const date = route.jobs[0]?.appointment.split(' ')[0] || new Date().toLocaleDateString();
      const name = filename(route, installer);
      await call('send', { email: installer.email.trim(), filename: name, contentBase64: base64, dispatchId: `${dispatchId}-${i + 1}`, orderIds: route.jobs.map(j => j.id), subject: `Installation work orders – ${date} – ${route.jobs.length} stops`, body: `Hello ${installer.name.trim()},\n\nAttached are your ${route.jobs.length} assigned work orders in recommended stop order.\n\nWork orders: ${route.jobs.map(j => j.id).join(', ')}\n\nPlease contact dispatch if an assignment needs to change.` });
      setSent(old => ({ ...old, [i]: true })); setStatus(`Email flow accepted route ${i + 1} for ${installer.email}.`);
    } catch (error) { setStatus(`Route ${i + 1}: ${error.message}`); }
    finally { setBusy(false); }
  }

  return <main>
    <header><div><span className="eyebrow">DISPATCH WORKSPACE</span><h1>New York work order router</h1><p>Upload one or more PDFs. Check each address. Build installer packets in stop order.</p></div><span className="pill">Local PDF processing</span></header>
    <section className="panel"><h2>1. Upload work orders</h2><p>Choose PDFs together or add them one at a time. Each PDF can contain multiple work orders, one per page. Adding or removing a file restarts address review; the files stay in this browser until you close the tab.</p><input aria-label="Add PDF files" type="file" accept="application/pdf" multiple disabled={busy || anySent} onChange={e => { if (e.target.files.length) upload([...files, ...Array.from(e.target.files)]); e.target.value = ''; }}/>{files.length > 0 && <><strong>{files.length} PDF{files.length === 1 ? '' : 's'} · {jobs.length} work orders</strong><ul className="file-list">{files.map((f, i) => <li key={`${i}-${f.name}`}>{f.name} <button className="quiet compact" disabled={busy || anySent} onClick={() => removeFile(i)} aria-label={`Remove ${f.name}`}>Remove</button></li>)}</ul><button className="quiet" disabled={busy} onClick={clearBatch}>Start new batch</button></>}</section>
    <section className="panel"><h2>2. Review addresses</h2><p>Address matching sends street addresses to the U.S. Census service; original PDF pages are not sent.</p>
      {jobs.length > 0 && <><div className="scroll"><table><thead><tr><th>File / Page / WO</th><th>Street</th><th>City</th><th>State</th><th>ZIP</th><th>Address check</th></tr></thead><tbody>{jobs.map(j => <tr key={j.page}><td><small className="source-name" title={j.sourceName}>{j.sourceName}</small>Page {j.sourcePage ?? j.page}<br/><input className="short" aria-label={`Work order page ${j.page}`} value={j.id} onChange={e => editJob(j.page, 'id', e.target.value)}/>{j.errors.includes('Duplicate work order number') && <button className="quiet compact remove-duplicate" disabled={busy || anySent} onClick={() => excludeJob(j.page)}>Remove duplicate</button>}</td><td><input aria-label={`Street page ${j.page}`} value={j.street} onChange={e => editJob(j.page, 'street', e.target.value)}/></td><td><input aria-label={`City page ${j.page}`} value={j.city} onChange={e => editJob(j.page, 'city', e.target.value)}/></td><td><input className="state" aria-label={`State page ${j.page}`} value={j.state} onChange={e => editJob(j.page, 'state', e.target.value.toUpperCase())}/></td><td><input className="zip" aria-label={`ZIP page ${j.page}`} value={j.zip} onChange={e => editJob(j.page, 'zip', e.target.value)}/></td><td className={j.errors.length || (j.geo && j.geo.match !== 'Match') ? 'warn' : 'good'}>{j.errors.join('; ') || (j.geo ? j.geo.match === 'Match' ? `Matched: ${j.geo.matchedAddress}` : j.geo.match === 'Zip_Estimate' || j.geo.match === 'Manual' ? j.geo.matchedAddress : 'No exact match — edit and retry' : 'Not checked')}{j.geo?.match !== 'Match' && <div className="pin-tools"><button className="quiet" disabled={busy || !j.street || !j.city || j.state !== 'NY' || !/^\d{5}$/.test(j.zip)} onClick={() => geocode([j.page])}>Check this address</button>{j.geo?.match !== 'Zip_Estimate' && zipEstimate(jobs, j.zip) && <button className="quiet" disabled={busy} onClick={() => useZipArea(j.page)}>Use ZIP area</button>}<div className="pin-input"><input aria-label={`Latitude page ${j.page}`} placeholder="Latitude" inputMode="decimal" value={j.manualLat || ''} onChange={e => setJobs(old => old.map(x => x.page === j.page ? { ...x, manualLat: e.target.value } : x))}/><input aria-label={`Longitude page ${j.page}`} placeholder="Longitude" inputMode="decimal" value={j.manualLon || ''} onChange={e => setJobs(old => old.map(x => x.page === j.page ? { ...x, manualLon: e.target.value } : x))}/><button className="quiet" disabled={busy} onClick={() => setManualPin(j.page)}>Set dispatch pin</button></div><small>Use a verified location. ZIP area and manual pins require approval after routing.</small></div>}</td></tr>)}</tbody></table></div>{excludedJobs.length > 0 && <div className="excluded"><strong>Removed from this batch ({excludedJobs.length})</strong><ul>{excludedJobs.map(j => <li key={j.page}>WO {j.id || '(missing number)'} · {j.sourceName} page {j.sourcePage ?? j.page} <button className="quiet compact" disabled={busy || anySent} onClick={() => restoreJob(j.page)}>Restore</button></li>)}</ul></div>}<button disabled={busy || hasErrors || jobs.some(j => !j.id || !j.street || !j.city || j.state !== 'NY' || !/^\d{5}$/.test(j.zip))} onClick={() => geocode()}>Match all addresses</button></>}
    </section>
    <section className="panel"><h2>3. Assign installers</h2><p>Enter installer names to test routes. Company email is needed only when sending packets. Strict dispatch requires 14–16 stops per route.</p>{installers.map((x, i) => <div className="installer" key={i}><input aria-label={`Installer ${i + 1} name`} placeholder="Installer name" value={x.name} onChange={e => { setInstallers(old => old.map((y, k) => k === i ? { ...y, name: e.target.value } : y)); invalidate(); }}/><input aria-label={`Installer ${i + 1} email`} type="email" placeholder="installer@company.com (optional for testing)" value={x.email} onChange={e => { setInstallers(old => old.map((y, k) => k === i ? { ...y, email: e.target.value } : y)); invalidate(); }}/><button className="quiet" disabled={installers.length === 1} onClick={() => { setInstallers(old => old.filter((_, k) => k !== i)); invalidate(); }}>Remove</button></div>)}<button className="quiet" onClick={() => { setInstallers(old => [...old, { name: '', email: '' }]); invalidate(); }}>+ Add installer</button>
      <label>Dispatcher password (only for configured road routing or email)<input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} placeholder="Leave blank for approximate route testing"/></label>
      {jobs.length > 0 && <p className={capacityReady ? 'good' : 'warn'}>{counts ? `Feasible: ${counts.join(', ')} jobs per installer.` : `${jobs.length} jobs cannot fill ${installers.length} routes at 14–16 each.`}</p>}
      <label className="check"><input type="checkbox" checked={pilot} onChange={e => { setPilot(e.target.checked); invalidate(); }}/> Pilot override: allow fewer than 14 stops (clearly review the results)</label>
      <div className="choice"><label><input type="radio" name="mode" value="approximate" checked={mode === 'approximate'} onChange={() => { setMode('approximate'); invalidate(); }}/> Free approximate distance (no drive times)</label><label><input type="radio" name="mode" value="roads" checked={mode === 'roads'} onChange={() => { setMode('roads'); invalidate(); }}/> Driving times (requires configured OSRM server)</label></div>
      <button disabled={busy || !geoReady || hasErrors || !installerReady || !capacityReady} onClick={buildRoutes}>Build routes</button>
    </section>
    {routes.length > 0 && <section className="panel"><h2>4. Review and send packets</h2><p>Every uploaded order is assigned once. Review the actual address, appointment and directions. For an uncertain location, set its installer and stop order, then approve it before emailing. Travel estimates exclude installation time and travel to the first stop; editing a route clears its old estimate.</p><p className="warn">A ZIP area or manual pin is an approximate planning location, not a verified street address. Confirm the destination with the customer or an approved source before dispatch.</p>{routes.map((r, i) => <article className="route" key={i}><div className="routehead"><div><h3>Route {i + 1} · {installers[i].name} · {r.jobs.length} stops</h3><small>{r.travelMinutes == null ? 'Route edited · travel estimate unavailable' : `${mode === 'roads' ? 'Road' : 'Approximate'} travel between stops: ${r.travelMinutes} min`}</small>{(r.jobs.length < 14 || r.jobs.length > 16) && <small className="warn"> · Outside the usual 14–16 stop target</small>}</div><div className="actions"><button className="quiet" onClick={async () => { const pdf = await packet(sources, r); download(pdf, filename(r, installers[i])); }}>Download PDF</button><button disabled={busy || sent[i] || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(installers[i].email) || r.jobs.some(j => j.geo?.match !== 'Match' && !j.reviewed)} onClick={() => sendRoute(r, installers[i], i)}>{sent[i] ? 'Accepted by email flow' : 'Email this installer'}</button></div></div><div className="links">{mapLinks(r).map((url, k) => <a key={k} href={url} target="_blank" rel="noreferrer">Directions segment {k + 1} ↗</a>)}</div><ol>{r.jobs.map((j, k) => <li key={j.page}><div><strong>WO {j.id}</strong> · {j.street}, {j.city} {j.zip} <small>· {j.sourceName} page {j.sourcePage ?? j.page} · appointment {j.appointment || 'unknown'}</small></div><div className="stop-controls"><button className="quiet compact" disabled={anySent || k === 0} onClick={() => moveStop(i, k, -1)} aria-label={`Move WO ${j.id} earlier`}>↑ Earlier</button><button className="quiet compact" disabled={anySent || k === r.jobs.length - 1} onClick={() => moveStop(i, k, 1)} aria-label={`Move WO ${j.id} later`}>↓ Later</button>{routes.length > 1 && <label>Installer <select aria-label={`Installer for WO ${j.id}`} value={i} disabled={anySent} onChange={e => changeRouteJob(i, k, Number(e.target.value))}>{installers.map((x, target) => <option key={target} value={target} disabled={target !== i && (routes[target].jobs.length >= 16 || r.jobs.length <= 1)}>{x.name}</option>)}</select></label>}</div>{j.geo?.match !== 'Match' && <label className="check review"><input type="checkbox" checked={!!j.reviewed} disabled={anySent} onChange={e => reviewStop(i, j.page, e.target.checked)}/> I verified the actual service location and approve this assignment ({j.geo?.match === 'Manual' ? 'dispatch pin' : 'ZIP area estimate'})</label>}</li>)}</ol></article>)}</section>}
    <div role="status" className="status">{busy ? 'Working… ' : ''}{status}</div>
    <footer>Private dispatcher tool · No PDF storage or route history · Verify times, traffic, and appointments before sending.</footer>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
