'use strict';
// renderPdf's one promise to its callers: whatever they pass — lean
// documents, ObjectIds — is normalised BEFORE it crosses to a worker.
// The page-count checks in renderPdf.test.js cannot see this (an id
// printed as "[object Object]" still fills the same pages), so the pool
// is replaced here and the payload it would have been sent is inspected.

jest.mock('../../utils/workerPool', () => ({
  runJob: jest.fn(async () => Buffer.from('%PDF-stub')),
}));

const mongoose = require('mongoose');
const { runJob } = require('../../utils/workerPool');
const { renderPdf } = require('../../utils/renderPdf');

beforeEach(() => runJob.mockClear());

it('sends the shift sheet ids as the strings they print as', async () => {
  const id = new mongoose.Types.ObjectId();
  await renderPdf('shiftSheet', { rows: [{ sdId: id, machine: 'M-1' }] });
  const [jobName, [name, args]] = runJob.mock.calls[0];
  expect(jobName).toBe('pdf.render');
  expect(name).toBe('shiftSheet');
  expect(args[0].rows[0].sdId).toBe(id.toHexString());
});

it('sends every argument, in order', async () => {
  const tpl = { _id: new mongoose.Types.ObjectId(), elements: [] };
  await renderPdf('template', tpl, { dcNo: 7 });
  const [, [, args]] = runJob.mock.calls[0];
  expect(args).toHaveLength(2);
  expect(args[0]._id).toBe(tpl._id.toHexString());
  expect(args[1]).toEqual({ dcNo: 7 });
});

it('falls back to the request thread when no worker can start', async () => {
  runJob.mockImplementationOnce(async () => {
    throw Object.assign(new Error('no threads'), { code: 'WORKER_UNAVAILABLE' });
  });
  const buf = await renderPdf('shiftSheet', { dateLabel: 'x', shift: 'DAY', planNo: 'SP', rows: [], branding: {} });
  expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(buf.toString()).not.toBe('%PDF-stub');
});

it('does not hide any other failure behind the fallback', async () => {
  runJob.mockImplementationOnce(async () => { throw new Error('renderer blew up'); });
  await expect(renderPdf('shiftSheet', { rows: [] })).rejects.toThrow('renderer blew up');
});
