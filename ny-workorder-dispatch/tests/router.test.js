import { describe, expect, it } from 'vitest';
import { parseWorkOrder, safeStreet, packet, otherDatesPdf, readPdfs, validateBatchJobs } from '../src/pdf.js';
import { feasibleCounts, optimize, approximateMatrix, zipEstimate, appointmentDate, groupByAppointmentDate, partitionForDispatch, buildDateRoutes } from '../src/routing.js';

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
    const makeFile = async (name, id, street, blank = false, date = '9/29/2026') => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([612, 792]);
      [
        `Work Order: ${id}`,
        `Appointment Date: ${date} 9:00:00 AM`,
        `Street 1: ${street}`,
        'City: Brooklyn      State: NY     Zip Code: 11206'
      ].forEach((line, i) => page.drawText(line, { x: 40, y: 720 - i * 25, font, size: 12 }));
      if (blank) doc.addPage([612, 792]);
      const bytes = await doc.save();
      return { name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    };
    const files = [await makeFile('first.pdf', '101', 'First Street', true), await makeFile('second.pdf', '102', 'Second Street', false, '10/1/2026')];
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
    const routedJobs = result.jobs.map((job, i) => ({ ...job, geo: { lat: 40.7 + i * .01, lon: -73.9 } }));
    const datedRoutes = buildDateRoutes(routedJobs, 1, approximateMatrix(routedJobs));
    expect(datedRoutes.map(r => [r.dateKey, r.jobs.map(j => j.id)])).toEqual([
      ['2026-09-29', ['101']], ['2026-10-01', ['102']]
    ]);
    const futurePdf = await packet(result.sources, datedRoutes[1]);
    const futureDocument = await legacy.getDocument({ data: futurePdf }).promise;
    expect(futureDocument.numPages).toBe(2);
    expect(await (await futureDocument.getPage(1)).getTextContent().then(content => content.items.map(x => x.str).join(' '))).toContain('2026-10-01');
    expect((await (await futureDocument.getPage(2)).getTextContent()).items.map(x => x.str).join(' ')).toContain('Second Street');
    await futureDocument.destroy();
    const { selected, other } = partitionForDispatch(result.jobs, '2026-09-29');
    expect(selected.map(j => j.id)).toEqual(['101']);
    expect(other.map(j => j.id)).toEqual(['102']);
    const heldPdf = await otherDatesPdf(result.sources, other);
    const heldDocument = await legacy.getDocument({ data: heldPdf }).promise;
    expect(heldDocument.numPages).toBe(1);
    expect((await (await heldDocument.getPage(1)).getTextContent()).items.map(x => x.str).join(' ')).toContain('Second Street');
    await heldDocument.destroy();
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

  it('splits mixed PDFs by actual appointment day, even for one future order', async () => {
    const jobs = Array.from({ length: 31 }, (_, i) => ({
      page: i + 1, id: String(i + 1),
      appointment: i === 2 ? '10/1/2026 9:00 AM' : i === 9 ? '9/30/2026 11:00 AM' : '9/29/2026 8:00 AM',
      geo: { lat: 40.6 + i * .001, lon: -73.9 + i * .001 }
    }));
    expect(appointmentDate(jobs[2])).toBe('2026-10-01');
    expect(groupByAppointmentDate(jobs).map(g => [g.dateKey, g.jobs.length])).toEqual([
      ['2026-09-29', 29], ['2026-09-30', 1], ['2026-10-01', 1]
    ]);
    const routes = buildDateRoutes(jobs, 2, approximateMatrix(jobs));
    expect(routes.map(r => [r.dateKey, r.jobs.length])).toEqual([
      ['2026-09-29', 15], ['2026-09-29', 14], ['2026-09-30', 1], ['2026-10-01', 1]
    ]);
    expect(routes.every(r => r.jobs.every(j => appointmentDate(j) === r.dateKey))).toBe(true);
    expect(routes.flatMap(r => r.jobs.map(j => j.id)).sort()).toEqual(jobs.map(j => j.id).sort());
    const { PDFDocument } = await import('pdf-lib');
    const source = await PDFDocument.create();
    for (const job of jobs) source.addPage([612, 792]);
    const futurePacket = await packet(await source.save(), routes[3]);
    expect((await PDFDocument.load(futurePacket)).getPageCount()).toBe(2);
    expect(appointmentDate(routes[3].jobs[0])).toBe('2026-10-01');
  });

  it('keeps every nonselected date in one holding PDF in original page order', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const input = await PDFDocument.create();
    const font = await input.embedFont(StandardFonts.Helvetica);
    for (const [index, date] of ['9/29/2026', '10/1/2026', '9/30/2026'].entries()) {
      const page = input.addPage([612, 792]);
      page.drawText(`WO ${index + 1}: ${date}`, { x: 40, y: 700, font, size: 12 });
    }
    const jobs = ['9/29/2026', '10/1/2026', '9/30/2026'].map((date, i) => ({ page: i + 1, id: String(i + 1), appointment: `${date} 9:00 AM` }));
    const { selected, other } = partitionForDispatch(jobs, '2026-09-29');
    expect(selected.map(j => j.id)).toEqual(['1']);
    expect(other.map(j => j.id)).toEqual(['2', '3']);
    expect(partitionForDispatch([...jobs, { id: '4', appointment: '' }], '2026-09-29').other.map(j => j.id)).toEqual(['2', '3', '4']);
    const held = await otherDatesPdf(await input.save(), other);
    const document = await pdfjs.getDocument({ data: held }).promise;
    expect(document.numPages).toBe(2);
    const pageText = async n => (await (await document.getPage(n)).getTextContent()).items.map(x => x.str).join(' ');
    expect(await pageText(1)).toContain('WO 2: 10/1/2026');
    expect(await pageText(2)).toContain('WO 3: 9/30/2026');
    await document.destroy();
  });

  it('requires a real appointment date and enough installers for each individual day', () => {
    expect(appointmentDate({ appointment: '2/30/2026 9:00 AM' })).toBeNull();
    const job = i => ({ page: i + 1, id: String(i + 1), appointment: '9/29/2026 9:00 AM', geo: { lat: 40.7, lon: -73.9 } });
    const jobs = Array.from({ length: 17 }, (_, i) => job(i));
    expect(() => buildDateRoutes(jobs, 1, approximateMatrix(jobs))).toThrow(/Add installers for this date/);
    expect(validateBatchJobs([{ ...job(0), appointment: '' }])[0].errors).toContain('Missing or invalid appointment date');
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
