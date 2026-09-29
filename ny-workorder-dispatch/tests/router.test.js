import { describe, expect, it } from 'vitest';
import { parseWorkOrder, safeStreet, packet, readPdfs, validateBatchJobs } from '../src/pdf.js';
import { feasibleCounts, optimize, approximateMatrix, zipEstimate } from '../src/routing.js';

describe('work order extraction', () => {
  it('reads labeled fields and rejects incomplete pages', () => {
    const text = 'Work Order: 13702621\nAppointment Date: 9/29/2026 10:31:00 AM\nStreet 1: 556 Flushing Ave Apt 3A\nCity: Brooklyn      State: NY     Zip Code: 11206';
    expect(parseWorkOrder(text, 1)).toMatchObject({ id: '13702621', street: '556 Flushing Ave Apt 3A', city: 'Brooklyn', zip: '11206', errors: [] });
    expect(parseWorkOrder('Work Order: 1', 2).errors).toContain('Incomplete service address');
    expect(safeStreet('11530 114TH PL FL 1')).toBe('11530 114TH PL');
  });

  it('clears duplicate errors when one copy is removed and allows mixed appointment dates', () => {
    const jobs = [1, 2].map(page => ({ page, id: '101', street: 'Main St', city: 'Brooklyn', state: 'NY', zip: '11206', appointment: '9/29/2026 9:00 AM' }));
    expect(validateBatchJobs(jobs).every(j => j.errors.includes('Duplicate work order number'))).toBe(true);
    expect(validateBatchJobs(jobs.slice(0, 1))[0].errors).toEqual([]);
    const differentDate = { ...jobs[1], id: '102', appointment: '9/30/2026 9:00 AM' };
    expect(validateBatchJobs([jobs[0], differentDate]).every(j => j.errors.length === 0)).toBe(true);
    expect(validateBatchJobs([jobs[0]])[0].errors).toEqual([]);
  });

  it('combines PDFs, keeps original page references, and detects cross-file duplicates', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
    const makeFile = async (name, id, street, blank = false) => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([612, 792]);
      [
        `Work Order: ${id}`,
        'Appointment Date: 9/29/2026 9:00:00 AM',
        `Street 1: ${street}`,
        'City: Brooklyn      State: NY     Zip Code: 11206'
      ].forEach((line, i) => page.drawText(line, { x: 40, y: 720 - i * 25, font, size: 12 }));
      if (blank) doc.addPage([612, 792]);
      const bytes = await doc.save();
      return { name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    };
    const files = [await makeFile('first.pdf', '101', 'First Street', true), await makeFile('second.pdf', '102', 'Second Street')];
    const result = await readPdfs(files);
    expect(result.jobs.map(j => [j.id, j.page, j.sourceIndex, j.sourcePage, j.sourceName])).toEqual([
      ['101', 1, 0, 1, 'first.pdf'], ['102', 3, 1, 1, 'second.pdf']
    ]);
    expect(result.skippedPages).toEqual(['first.pdf page 2']);
    const output = await packet(result.sources, { jobs: [result.jobs[1], result.jobs[0]] });
    const legacy = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await legacy.getDocument({ data: output }).promise;
    const pageText = async n => (await (await document.getPage(n)).getTextContent()).items.map(x => x.str).join(' ');
    expect(await pageText(2)).toContain('Second Street');
    expect(await pageText(3)).toContain('First Street');
    await document.destroy();
    const duplicate = await readPdfs([files[0], await makeFile('duplicate.pdf', '101', 'Another Street')]);
    expect(duplicate.jobs.every(j => j.errors.includes('Duplicate work order number'))).toBe(true);
  });
});

describe('route constraints and packet isolation', () => {
  it('uses only exact same-ZIP anchors for a location estimate', () => {
    const jobs = [
      { zip: '11206', geo: { match: 'Match', lat: 40.7, lon: -73.95 } },
      { zip: '11206', geo: { match: 'No_Match', lat: 40.1, lon: -74.2 } },
      { zip: '11207', geo: { match: 'Match', lat: 40.9, lon: -73.8 } }
    ];
    expect(zipEstimate(jobs, '11206')).toMatchObject({ match: 'Zip_Estimate', lat: 40.7, lon: -73.95 });
    expect(zipEstimate(jobs, '11239')).toMatchObject({ match: 'Zip_Estimate', lat: 40.6497, lon: -73.8824 });
    expect(zipEstimate(jobs, '00000')).toBeNull();
  });
  it('enforces 14–16 and gives every page to one route', () => {
    expect(feasibleCounts(50, 3)).toBeNull();
    expect(feasibleCounts(30, 2)).toEqual([15, 15]);
    const jobs = Array.from({ length: 30 }, (_, i) => ({ page: i + 1, id: String(i + 1), geo: { lat: 40.6 + i * .001, lon: -73.9 + i * .001 } }));
    const routes = optimize(jobs, 2, approximateMatrix(jobs));
    expect(routes.map(r => r.jobs.length)).toEqual([15, 15]);
    expect(new Set(routes.flatMap(r => r.jobs.map(j => j.page))).size).toBe(30);
  });

  it('merges only the assigned source pages and preserves their order', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([612, 792]);
    const bytes = await doc.save();
    const assigned = await packet(bytes, { jobs: [{ page: 3 }, { page: 1 }] });
    expect((await PDFDocument.load(assigned)).getPageCount()).toBe(3);
  });

  it('marks approximate stops as reviewed or unreviewed on the packet', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const source = await PDFDocument.create(); source.addPage([612, 792]);
    const bytes = await source.save();
    const job = { page: 1, id: '42', street: 'Example Street', city: 'Albany', state: 'NY', zip: '12207', geo: { match: 'Zip_Estimate' } };
    for (const reviewed of [false, true]) {
      const output = await packet(bytes, { jobs: [{ ...job, reviewed }] });
      const document = await pdfjs.getDocument({ data: output }).promise;
      const text = (await (await document.getPage(1)).getTextContent()).items.map(x => x.str).join(' ');
      expect(text).toContain(`APPROX LOCATION ${reviewed ? 'REVIEWED' : 'NOT REVIEWED'}`);
      await document.destroy();
    }
  });
});
