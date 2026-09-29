import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readPdfs, packet, otherDatesPdf, safeStreet, validateBatchJobs } from './pdf.js';
import { approximateMatrix, buildDateRoutes, partitionForDispatch, appointmentDate, zipEstimate } from './routing.js';
import './style.css';

function App() {
  const [password, setPassword] = useState('');
  const [files, setFiles] = useState([]);
  const [sources, setSources] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [dispatchDate, setDispatchDate] = useState('');
  const [excludedJobs, setExcludedJobs] = useState([]);
  const [installers, setInstallers] = useState([{ name: '', email: '' }]);
  const [routes, setRoutes] = useState([]);
  const [mode, setMode] = useState('approximate');
  const [pilot, setPilot] = useState(false);
  const [status, setStatus] = useState('Choose one or more PDFs to start.');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState({});
  const [dispatchId, setDispatchId] = useState('');

  const { selected: selectedRaw, other: otherDateJobs } = partitionForDispatch(jobs, dispatchDate);
  const selectedJobs = validateBatchJobs(selectedRaw);
  const hasErrors = selectedJobs.some(j => j.errors.length);
  const geoReady = selectedJobs.length > 0 && selectedJobs.every(j => j.geo && Number.isFinite(j.geo.lat) && Number.isFinite(j.geo.lon) && ['Match', 'Zip_Estimate', 'Manual'].includes(j.geo.match));
  const capacityReady = selectedJobs.length > 0 && selectedJobs.length <= 16 * installers.length;
  const availableDates = [...new Set(jobs.map(appointmentDate).filter(Boolean))].sort();
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
      setStatus(`${result.jobs.length} work orders found across ${selected.length} PDF${selected.length === 1 ? '' : 's'}${result.skippedPages.length ? `; skipped blank ${result.skippedPages.join(', ')}` : ''}. Choose the installation date to dispatch.`);
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }
  function clearBatch() {
    setFiles([]); setSources([]); setJobs([]); setDispatchDate(''); setExcludedJobs([]); invalidate();
    setStatus('Choose one or more PDFs to start.');
  }
  function removeFile(index) {
    const remaining = files.filter((_, i) => i !== index);
    if (remaining.length) upload(remaining);
    else clearBatch();
  }
  function editJob(page, key, value) {
    if (anySent) return;
    setJobs(old => validateBatchJobs(old.map(j => j.page === page ? { ...j, [key]: value, geo: key === 'appointment' || key === 'id' ? j.geo : null } : j)));
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
    if (anySent) return;
    setBusy(true); invalidate();
    try {
      const selected = pages ? selectedJobs.filter(j => pages.includes(j.page)) : selectedJobs;
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
    if (anySent) return;
    const target = selectedJobs.find(j => j.page === page);
    const estimate = zipEstimate(selectedJobs, target.zip);
    if (!estimate) return;
    setJobs(old => old.map(j => j.page === page ? { ...j, geo: estimate } : j));
    invalidate();
    setStatus(`Page ${page} uses an approximate ZIP-area location. Review its installer and stop order before dispatch.`);
  }
  function setManualPin(page) {
    if (anySent) return;
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
      let matrix = approximateMatrix(selectedJobs);
      if (mode === 'roads') matrix = (await call('matrix', { points: selectedJobs.map(j => ({ lon: j.geo.lon, lat: j.geo.lat })) })).matrix;
      const next = buildDateRoutes(selectedJobs, installers.length, matrix, { spreadShort: pilot });
      setRoutes(next); setSent({}); setDispatchId(globalThis.crypto.randomUUID());
      setStatus(`${next.length} route${next.length === 1 ? '' : 's'} for ${dispatchDate} ready. ${otherDateJobs.length} other-date work order${otherDateJobs.length === 1 ? '' : 's'} kept out of dispatch.`);
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }
  function download(data, name) {
    const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function downloadOtherDates() {
    setBusy(true);
    try {
      download(await otherDatesPdf(sources, otherDateJobs), `Other_Dates_Excluded_from_${dispatchDate}_${otherDateJobs.length}_WorkOrders.pdf`);
      setStatus(`${otherDateJobs.length} other-date work orders saved in a separate PDF. They were not assigned to installers.`);
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }
  const filename = (route, installer) => {
    return `${installer.name.trim().replace(/[^\w-]+/g, '_')}_${route.dateKey}_${route.jobs.length}_WorkOrders.pdf`;
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
      if (!next[targetIndex] || next[targetIndex].dateKey !== next[routeIndex].dateKey || next[targetIndex].jobs.length >= 16 || next[routeIndex].jobs.length <= 1) return old;
      const [job] = next[routeIndex].jobs.splice(jobIndex, 1);
      next[targetIndex].jobs.push({ ...job, reviewed: false });
      next[routeIndex].travelMinutes = null;
      next[targetIndex].travelMinutes = null;
      return next;
    });
    setStatus('Assignment changed. Review the destination route and directions before dispatch.');
  }
  function changeRouteInstaller(routeIndex, installerIndex) {
    if (anySent) return;
    setRoutes(old => {
      const route = old[routeIndex];
      if (old.some((r, index) => index !== routeIndex && r.dateKey === route.dateKey && r.installerIndex === installerIndex)) return old;
      return old.map((r, index) => index === routeIndex ? { ...r, installerIndex, jobs: r.jobs.map(j => ({ ...j, reviewed: false })) } : r);
    });
    setStatus('Installer changed. Review the route and any approximate locations before dispatch.');
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
      const date = route.dateKey;
      const name = filename(route, installer);
      await call('send', { email: installer.email.trim(), filename: name, contentBase64: base64, dispatchId: `${dispatchId}-${i + 1}`, orderIds: route.jobs.map(j => j.id), subject: `Installation work orders – ${date} – ${route.jobs.length} stops`, body: `Hello ${installer.name.trim()},\n\nAttached are your ${route.jobs.length} assigned work orders in recommended stop order.\n\nWork orders: ${route.jobs.map(j => j.id).join(', ')}\n\nPlease contact dispatch if an assignment needs to change.` });
      setSent(old => ({ ...old, [i]: true })); setStatus(`Email flow accepted route ${i + 1} for ${installer.email}.`);
    } catch (error) { setStatus(`Route ${i + 1}: ${error.message}`); }
    finally { setBusy(false); }
  }

  return <main>
    <header><div><span className="eyebrow">DISPATCH WORKSPACE</span><h1>New York work order router</h1><p>Upload one or more PDFs. Check each address. Build installer packets in stop order.</p></div><span className="pill">Local PDF processing</span></header>
    <section className="panel"><h2>1. Upload work orders</h2><p>Choose PDFs together or add them one at a time. Each PDF can contain multiple work orders, one per page. Adding or removing a file restarts address review; the files stay in this browser until you close the tab.</p><input aria-label="Add PDF files" type="file" accept="application/pdf" multiple disabled={busy || anySent} onChange={e => { if (e.target.files.length) upload([...files, ...Array.from(e.target.files)]); e.target.value = ''; }}/>{files.length > 0 && <><strong>{files.length} PDF{files.length === 1 ? '' : 's'} · {jobs.length} work orders</strong><ul className="file-list">{files.map((f, i) => <li key={`${i}-${f.name}`}>{f.name} <button className="quiet compact" disabled={busy || anySent} onClick={() => removeFile(i)} aria-label={`Remove ${f.name}`}>Remove</button></li>)}</ul><button className="quiet" disabled={busy} onClick={clearBatch}>Start new batch</button></>}</section>
    {jobs.length > 0 && <section className="panel"><h2>2. Choose installation date</h2><p>Enter the day you want to dispatch. Only orders with that Appointment Date will be matched, routed, and sent to installers.</p><label>Installation date <input type="date" aria-label="Installation date to dispatch" value={dispatchDate} disabled={busy || anySent} onChange={e => { setDispatchDate(e.target.value); invalidate(); }}/></label><p>Dates found: {availableDates.map(date => `${date} (${jobs.filter(j => appointmentDate(j) === date).length})`).join(', ') || 'none'}.</p>{dispatchDate && <><p className={selectedRaw.length ? 'good' : 'warn'}>{selectedRaw.length} order{selectedRaw.length === 1 ? '' : 's'} for {dispatchDate} selected · {otherDateJobs.length} other-date order{otherDateJobs.length === 1 ? '' : 's'} held out. {otherDateJobs.some(j => !appointmentDate(j)) && 'Orders without a readable date are included in the other-dates PDF.'}</p>{selectedRaw.length > 0 && otherDateJobs.length > 0 && <button className="quiet" disabled={busy} onClick={downloadOtherDates}>Download other dates PDF ({otherDateJobs.length})</button>}{otherDateJobs.length > 0 && <div className="scroll"><table><thead><tr><th>Held work order</th><th>Appointment Date on order</th></tr></thead><tbody>{otherDateJobs.map(j => <tr key={j.page}><td>WO {j.id || '(missing number)'} · {j.sourceName} page {j.sourcePage ?? j.page}</td><td><input aria-label={`Held appointment date page ${j.page}`} value={j.appointment} disabled={anySent} onChange={e => editJob(j.page, 'appointment', e.target.value)} placeholder="M/D/YYYY 9:00 AM"/>{!appointmentDate(j) && <small className="warn">Unreadable date — correct it here if this order belongs to {dispatchDate}.</small>}</td></tr>)}</tbody></table></div>}</>}</section>}
    <section className="panel"><h2>3. Review selected date addresses</h2><p>Address matching sends street addresses to the U.S. Census service; original PDF pages are not sent.</p>
      {selectedJobs.length > 0 && <><div className="scroll"><table><thead><tr><th>File / Page / WO</th><th>Appointment Date</th><th>Street</th><th>City</th><th>State</th><th>ZIP</th><th>Address check</th></tr></thead><tbody>{selectedJobs.map(j => <tr key={j.page}><td><small className="source-name" title={j.sourceName}>{j.sourceName}</small>Page {j.sourcePage ?? j.page}<br/><input className="short" aria-label={`Work order page ${j.page}`} value={j.id} disabled={anySent} onChange={e => editJob(j.page, 'id', e.target.value)}/>{j.errors.includes('Duplicate work order number') && <button className="quiet compact remove-duplicate" disabled={busy || anySent} onClick={() => excludeJob(j.page)}>Remove duplicate</button>}</td><td><input aria-label={`Appointment Date page ${j.page}`} value={j.appointment} disabled={anySent} onChange={e => editJob(j.page, 'appointment', e.target.value)} placeholder="M/D/YYYY 9:00 AM"/>{!appointmentDate(j) && <small className="warn">Enter the date printed on this order.</small>}</td><td><input aria-label={`Street page ${j.page}`} value={j.street} disabled={anySent} onChange={e => editJob(j.page, 'street', e.target.value)}/></td><td><input aria-label={`City page ${j.page}`} value={j.city} disabled={anySent} onChange={e => editJob(j.page, 'city', e.target.value)}/></td><td><input className="state" aria-label={`State page ${j.page}`} value={j.state} disabled={anySent} onChange={e => editJob(j.page, 'state', e.target.value.toUpperCase())}/></td><td><input className="zip" aria-label={`ZIP page ${j.page}`} value={j.zip} disabled={anySent} onChange={e => editJob(j.page, 'zip', e.target.value)}/></td><td className={j.errors.length || (j.geo && j.geo.match !== 'Match') ? 'warn' : 'good'}>{j.errors.join('; ') || (j.geo ? j.geo.match === 'Match' ? `Matched: ${j.geo.matchedAddress}` : j.geo.match === 'Zip_Estimate' || j.geo.match === 'Manual' ? j.geo.matchedAddress : 'No exact match — edit and retry' : 'Not checked')}{j.geo?.match !== 'Match' && <div className="pin-tools"><button className="quiet" disabled={busy || anySent || !j.street || !j.city || j.state !== 'NY' || !/^\d{5}$/.test(j.zip)} onClick={() => geocode([j.page])}>Check this address</button>{j.geo?.match !== 'Zip_Estimate' && zipEstimate(selectedJobs, j.zip) && <button className="quiet" disabled={busy || anySent} onClick={() => useZipArea(j.page)}>Use ZIP area</button>}<div className="pin-input"><input aria-label={`Latitude page ${j.page}`} disabled={anySent} placeholder="Latitude" inputMode="decimal" value={j.manualLat || ''} onChange={e => setJobs(old => old.map(x => x.page === j.page ? { ...x, manualLat: e.target.value } : x))}/><input aria-label={`Longitude page ${j.page}`} disabled={anySent} placeholder="Longitude" inputMode="decimal" value={j.manualLon || ''} onChange={e => setJobs(old => old.map(x => x.page === j.page ? { ...x, manualLon: e.target.value } : x))}/><button className="quiet" disabled={busy || anySent} onClick={() => setManualPin(j.page)}>Set dispatch pin</button></div><small>Use a verified location. ZIP area and manual pins require approval after routing.</small></div>}</td></tr>)}</tbody></table></div>{excludedJobs.length > 0 && <div className="excluded"><strong>Removed from this batch ({excludedJobs.length})</strong><ul>{excludedJobs.map(j => <li key={j.page}>WO {j.id || '(missing number)'} · {j.sourceName} page {j.sourcePage ?? j.page} <button className="quiet compact" disabled={busy || anySent} onClick={() => restoreJob(j.page)}>Restore</button></li>)}</ul></div>}<button disabled={busy || anySent || hasErrors || selectedJobs.some(j => !j.id || !j.street || !j.city || j.state !== 'NY' || !/^\d{5}$/.test(j.zip))} onClick={() => geocode()}>Match all addresses</button></>}
    </section>
    <section className="panel"><h2>4. Assign installers</h2><p>Enter installer names to test routes for the selected date. Company email is needed only when sending packets. A route can have at most 16 stops.</p>{installers.map((x, i) => <div className="installer" key={i}><input aria-label={`Installer ${i + 1} name`} disabled={anySent} placeholder="Installer name" value={x.name} onChange={e => { setInstallers(old => old.map((y, k) => k === i ? { ...y, name: e.target.value } : y)); invalidate(); }}/><input aria-label={`Installer ${i + 1} email`} disabled={anySent} type="email" placeholder="installer@company.com (optional for testing)" value={x.email} onChange={e => { setInstallers(old => old.map((y, k) => k === i ? { ...y, email: e.target.value } : y)); invalidate(); }}/><button className="quiet" disabled={anySent || installers.length === 1} onClick={() => { setInstallers(old => old.filter((_, k) => k !== i)); invalidate(); }}>Remove</button></div>)}<button className="quiet" disabled={anySent} onClick={() => { setInstallers(old => [...old, { name: '', email: '' }]); invalidate(); }}>+ Add installer</button>
      <label>Dispatcher password (only for configured road routing or email)<input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} placeholder="Leave blank for approximate route testing"/></label>
      {jobs.length > 0 && <p className={capacityReady ? 'good' : 'warn'}>{!dispatchDate ? 'Choose the installation date above.' : !selectedJobs.length ? `No work orders found for ${dispatchDate}.` : capacityReady ? `${selectedJobs.length} stops on ${dispatchDate} · ${otherDateJobs.length} held for other dates.` : `Add installers for ${dispatchDate} (maximum ${16 * installers.length} stops).`}</p>}
      <label className="check"><input type="checkbox" checked={pilot} disabled={anySent} onChange={e => { setPilot(e.target.checked); invalidate(); }}/> Spread selected date across available installers (allows shorter routes)</label>
      <div className="choice"><label><input type="radio" name="mode" value="approximate" checked={mode === 'approximate'} disabled={anySent} onChange={() => { setMode('approximate'); invalidate(); }}/> Free approximate distance (no drive times)</label><label><input type="radio" name="mode" value="roads" checked={mode === 'roads'} disabled={anySent} onChange={() => { setMode('roads'); invalidate(); }}/> Driving times (requires configured OSRM server)</label></div>
      <button disabled={busy || anySent || !geoReady || hasErrors || !installerReady || !capacityReady} onClick={buildRoutes}>Build routes</button>
    </section>
    {routes.length > 0 && <section className="panel"><h2>5. Review and send packets</h2><p>Only orders for the selected date are assigned to installer routes. Each route creates a separate PDF for that date. Other dates remain available through Download other dates PDF above. Review the actual address, appointment and directions. For an uncertain location, set its installer and stop order, then approve it before emailing. Travel estimates exclude installation time and travel to the first stop; editing a route clears its old estimate.</p><p className="warn">A ZIP area or manual pin is an approximate planning location, not a verified street address. Confirm the destination with the customer or an approved source before dispatch.</p>{routes.map((r, i) => <article className="route" key={i}><div className="routehead"><div><h3>Route {i + 1} · {r.dateKey} · {installers[r.installerIndex].name} · {r.jobs.length} stops</h3><small>{r.travelMinutes == null ? 'Route edited · travel estimate unavailable' : `${mode === 'roads' ? 'Road' : 'Approximate'} travel between stops: ${r.travelMinutes} min`}</small>{(r.jobs.length < 14 || r.jobs.length > 16) && <small className="warn"> · Outside the usual 14–16 stop target</small>}<label>Assign route to <select aria-label={`Installer for route ${i + 1} on ${r.dateKey}`} value={r.installerIndex} disabled={anySent} onChange={e => changeRouteInstaller(i, Number(e.target.value))}>{installers.map((x, index) => <option key={index} value={index} disabled={routes.some((other, otherIndex) => otherIndex !== i && other.dateKey === r.dateKey && other.installerIndex === index)}>{x.name}</option>)}</select></label></div><div className="actions"><button className="quiet" onClick={async () => { const pdf = await packet(sources, r); download(pdf, filename(r, installers[r.installerIndex])); }}>Download PDF</button><button disabled={busy || sent[i] || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(installers[r.installerIndex].email) || r.jobs.some(j => j.geo?.match !== 'Match' && !j.reviewed)} onClick={() => sendRoute(r, installers[r.installerIndex], i)}>{sent[i] ? 'Accepted by email flow' : 'Email this installer'}</button></div></div><div className="links">{mapLinks(r).map((url, k) => <a key={k} href={url} target="_blank" rel="noreferrer">Directions segment {k + 1} ↗</a>)}</div><ol>{r.jobs.map((j, k) => <li key={j.page}><div><strong>WO {j.id}</strong> · {j.street}, {j.city} {j.zip} <small>· {j.sourceName} page {j.sourcePage ?? j.page} · appointment {j.appointment || 'unknown'}</small></div><div className="stop-controls"><button className="quiet compact" disabled={anySent || k === 0} onClick={() => moveStop(i, k, -1)} aria-label={`Move WO ${j.id} earlier`}>↑ Earlier</button><button className="quiet compact" disabled={anySent || k === r.jobs.length - 1} onClick={() => moveStop(i, k, 1)} aria-label={`Move WO ${j.id} later`}>↓ Later</button>{routes.some((other, index) => index !== i && other.dateKey === r.dateKey) && <label>Route <select aria-label={`Installer for WO ${j.id}`} value={i} disabled={anySent} onChange={e => changeRouteJob(i, k, Number(e.target.value))}>{routes.map((other, target) => other.dateKey === r.dateKey && <option key={target} value={target} disabled={target !== i && (other.jobs.length >= 16 || r.jobs.length <= 1)}>{installers[other.installerIndex].name} (route {target + 1})</option>)}</select></label>}</div>{j.geo?.match !== 'Match' && <label className="check review"><input type="checkbox" checked={!!j.reviewed} disabled={anySent} onChange={e => reviewStop(i, j.page, e.target.checked)}/> I verified the actual service location and approve this assignment ({j.geo?.match === 'Manual' ? 'dispatch pin' : 'ZIP area estimate'})</label>}</li>)}</ol></article>)}</section>}
    <div role="status" className="status">{busy ? 'Working… ' : ''}{status}</div>
    <footer>Private dispatcher tool · No PDF storage or route history · Verify times, traffic, and appointments before sending.</footer>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
