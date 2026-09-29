import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { appointmentDate } from './routing.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function parseWorkOrder(text, page) {
  const find = (pattern) => (text.match(pattern)?.[1] || '').trim();
  const id = find(/Work Order:\s*(\d+)/i);
  const street = find(/Street 1:\s*([^\r\n]+)/i);
  const street2 = find(/Street 2:\s*([^\r\n]*?)(?:\s{2,}County:|$)/im);
  const city = find(/City:\s*(.+?)\s+State:\s*[A-Z]{2}\s+Zip Code:/i);
  const state = find(/State:\s*([A-Z]{2})\s+Zip Code:/i);
  const zip = find(/Zip Code:\s*(\d{5})(?:-\d{4})?/i);
  const appointment = find(/Appointment Date:\s*([^\r\n]+)/i);
  const originalRoute = find(/ROUTE:\s*([^\r\n]+)/i);
  const errors = [];
  if (!id) errors.push('Missing work order number');
  if (!street || !city || !zip || !state) errors.push('Incomplete service address');
  if (state && state !== 'NY') errors.push('Outside NY');
  return { page, id, street, street2, city, state, zip, originalAddress: { street, street2, city, state, zip }, appointment, originalRoute, errors, geo: null };
}

export function validateBatchJobs(jobs) {
  const counts = new Map();
  for (const j of jobs) if (j.id?.trim()) counts.set(j.id.trim(), (counts.get(j.id.trim()) || 0) + 1);
  return jobs.map(j => {
    const errors = [];
    if (!j.id?.trim()) errors.push('Missing work order number');
    if (!appointmentDate(j)) errors.push('Missing or invalid appointment date');
    if (!j.street?.trim() || !j.city?.trim() || !j.zip?.trim() || !j.state?.trim()) errors.push('Incomplete service address');
    if (j.state && j.state !== 'NY') errors.push('Outside NY');
    if (j.id?.trim() && counts.get(j.id.trim()) > 1) errors.push('Duplicate work order number');
    return { ...j, errors };
  });
}

function pageLines(items) {
  const lines = [];
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const y = item.transform[5], x = item.transform[4];
    let line = lines.find(l => Math.abs(l.y - y) < 2);
    if (!line) { line = { y, parts: [] }; lines.push(line); }
    line.parts.push({ x, end: x + item.width, text: item.str });
  }
  return lines.sort((a, b) => b.y - a.y).map(l => {
    let out = '', end = -Infinity;
    for (const part of l.parts.sort((a, b) => a.x - b.x)) {
      out += (out && part.x > end + 1 ? ' ' : '') + part.text;
      end = Math.max(end, part.end);
    }
    return out;
  }).join('\n');
}

export async function readPdf(file, progress = () => {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  if (pdf.numPages > 500) throw new Error('Maximum 500 pages per upload');
  const jobs = [];
  const skippedPages = [];
  for (let page = 1; page <= pdf.numPages; page++) {
    const content = await (await pdf.getPage(page)).getTextContent();
    const text = pageLines(content.items);
    if (!text.trim()) skippedPages.push(page);
    else jobs.push(parseWorkOrder(text, page));
    progress(page, pdf.numPages);
  }
  return { bytes, jobs: validateBatchJobs(jobs), skippedPages, pageCount: pdf.numPages };
}

export async function readPdfs(files, progress = () => {}) {
  const selected = Array.from(files || []);
  if (!selected.length) throw new Error('Choose at least one PDF');
  const sources = [], jobs = [], skippedPages = [];
  let offset = 0;
  for (const [sourceIndex, file] of selected.entries()) {
    let result;
    try { result = await readPdf(file, (page, total) => progress(file.name, page, total, sourceIndex + 1, selected.length)); }
    catch (error) { throw new Error(`${file.name}: ${error.message}`); }
    if (offset + result.pageCount > 500) throw new Error('Maximum 500 pages across all selected PDFs');
    sources.push(result.bytes);
    jobs.push(...result.jobs.map(j => ({ ...j, page: offset + j.page, sourceIndex, sourcePage: j.page, sourceName: file.name })));
    skippedPages.push(...result.skippedPages.map(page => `${file.name} page ${page}`));
    offset += result.pageCount;
  }
  return { sources, jobs: validateBatchJobs(jobs), skippedPages, pageCount: offset };
}

export async function packet(sources, route) {
  const inputs = Array.isArray(sources) ? sources : [sources];
  const output = await PDFDocument.create();
  const cover = output.addPage([612, 792]);
  const font = await output.embedFont(StandardFonts.Helvetica);
  const bold = await output.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.10, 0.16, 0.20);
  const plain = s => String(s ?? '').replace(/[^\x20-\x7e]/g, '?');
  cover.drawText('INSTALLER ROUTE SHEET', { x: 38, y: 744, size: 17, font: bold, color: ink });
  cover.drawText(`${route.dateKey || appointmentDate(route.jobs[0]) || 'Date unconfirmed'} - ${route.jobs.length} stops - follow this order`, { x: 38, y: 721, size: 11, font, color: ink });
  cover.drawText('Addresses marked CORRECTED were edited by dispatch; original forms follow this sheet.', { x: 38, y: 700, size: 8.5, font, color: ink });
  cover.drawText('APPROX LOCATION uses a ZIP area or dispatch pin; confirm the actual service address.', { x: 38, y: 686, size: 8.5, font, color: ink });
  let y = 661;
  for (const [index, job] of route.jobs.entries()) {
    const changed = job.originalAddress && ['street', 'city', 'state', 'zip'].some(key => job[key] !== job.originalAddress[key]);
    const flag = `${changed ? ' - CORRECTED' : ''}${job.geo?.match === 'Zip_Estimate' || job.geo?.match === 'Manual' ? ` - APPROX LOCATION ${job.reviewed ? 'REVIEWED' : 'NOT REVIEWED'}` : ''}`;
    cover.drawText(plain(`${index + 1}. WO ${job.id}${flag}`).slice(0, 90), { x: 38, y, size: 10, font: bold, color: ink });
    cover.drawText(plain(`${job.street}${job.street2 ? ` ${job.street2}` : ''}, ${job.city}, ${job.state} ${job.zip}`).slice(0, 110), { x: 54, y: y - 14, size: 9, font, color: ink });
    y -= 38;
  }
  await copyWorkOrderPages(output, inputs, route.jobs);
  return output.save();
}

async function copyWorkOrderPages(output, inputs, jobs) {
  const documents = new Map();
  for (const job of jobs) {
    const sourceIndex = job.sourceIndex ?? 0;
    if (!inputs[sourceIndex]) throw new Error(`Missing source PDF for work order ${job.id || job.page}`);
    if (!documents.has(sourceIndex)) documents.set(sourceIndex, await PDFDocument.load(inputs[sourceIndex]));
    const [page] = await output.copyPages(documents.get(sourceIndex), [(job.sourcePage ?? job.page) - 1]);
    output.addPage(page);
  }
}

// A holding PDF of the untouched original order pages, with no installer route sheet.
export async function otherDatesPdf(sources, jobs) {
  if (!jobs.length) throw new Error('No other-date work orders to save');
  const output = await PDFDocument.create();
  await copyWorkOrderPages(output, Array.isArray(sources) ? sources : [sources], jobs);
  return output.save();
}

export function safeStreet(street) {
  return street.replace(/\s+(?:Apt|Apartment|Unit|Suite|Ste|Floor|Fl|#)\s*[\w-]+.*$/i, '').trim();
}
