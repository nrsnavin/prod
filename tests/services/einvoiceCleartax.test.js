'use strict';
// ══════════════════════════════════════════════════════════════════
//  E-INVOICES THROUGH CLEARTAX
//
//  The IRP API user was made with ClearTax as the GSP, and its name and
//  password are kept in ClearTax. Jarvis sends ClearTax the invoice's
//  INV-01 JSON with the workspace's auth token and the GSTIN; ClearTax
//  sends it on to the portal and hands back the portal's reply.
//
//    • the request: ClearTax's address and path, its headers, the JSON as it is
//    • the IRN, acknowledgement and signed QR taken back; the date read
//      as India time
//    • a repeat ClearTax already registered is taken as registered
//    • a refusal says ClearTax's codes and words; 2150 says what to do
//    • cancel and e-way bill
//    • the token goes to ClearTax only: never to another address left in
//      Settings, and not without the token or the GSTIN
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';

const { PROVIDERS } = require('../../services/einvoiceProvider');

const cfg = (over = {}) => ({
  provider: 'cleartax', baseUrl: 'https://api-sandbox.clear.in', clientSecret: 'ws-token-1', gstin: '33AAECB1234F1Z5',
  username: '', password: '', clientId: '', ...over,
});

const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
let fetchMock;
beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock; });
afterAll(() => { delete global.fetch; });

const INV01 = { Version: '1.1', DocDtls: { Typ: 'INV', No: 'INV/2026-27/0001', Dt: '13/11/2026' }, ItemList: [{ SlNo: '1' }] };
const IRN = 'a'.repeat(64);

describe('registering through ClearTax', () => {
  it('sends the INV-01 JSON as it is, with the token and GSTIN, and takes back the IRN', async () => {
    fetchMock.mockResolvedValue(reply({
      Success: 'Y', AckNo: 112610012345678, AckDt: '2026-11-13 10:30:00', Irn: IRN,
      SignedInvoice: 'eyJ.signed.invoice', SignedQRCode: 'eyJ.signed.qr', Status: 'ACT', InfoDtls: null,
    }));
    const reg = await PROVIDERS.cleartax(cfg()).register(INV01);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-sandbox.clear.in/einv/v1/govt/api/Invoice/');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/json', 'x-cleartax-auth-token': 'ws-token-1', 'x-cleartax-product': 'EInvoice', gstin: '33AAECB1234F1Z5',
    });
    expect(JSON.parse(init.body)).toEqual(INV01);
    expect(init.redirect).toBe('error');

    expect(reg).toMatchObject({ irn: IRN, ackNo: '112610012345678', signedQr: 'eyJ.signed.qr' });
    // ClearTax's clock is the portal's: 10:30 in India is 05:00 UTC.
    expect(reg.ackDate.toISOString()).toBe('2026-11-13T05:00:00.000Z');
  });

  it('goes to the live address when Settings hold none', async () => {
    fetchMock.mockResolvedValue(reply({ Success: 'Y', Irn: IRN, AckNo: 1, AckDt: '2026-11-13 10:30:00', SignedQRCode: 'q' }));
    await PROVIDERS.cleartax(cfg({ baseUrl: '' })).register(INV01);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.clear.in/einv/v1/govt/api/Invoice/');
  });

  it('takes a repeat that ClearTax had already registered as registered, with the same IRN', async () => {
    fetchMock.mockResolvedValue(reply({
      Success: 'Y', Irn: IRN, AckNo: 112610012345678, AckDt: '2026-11-13 10:30:00', SignedQRCode: 'eyJ.signed.qr',
      InfoDtls: [{ InfCd: 'DUPIRN_CLEARTAX', Desc: 'Duplicate IRN, details from ClearTax' }],
    }));
    const reg = await PROVIDERS.cleartax(cfg()).register(INV01);
    expect(reg.irn).toBe(IRN);
  });

  it("says ClearTax's codes and words when the portal refuses it", async () => {
    fetchMock.mockResolvedValue(reply({
      Success: 'N',
      ErrorDetails: [
        { error_code: '2172', error_message: 'Buyer GSTIN is invalid', error_source: 'IRP' },
        { error_code: '2211', error_message: 'Pincode of buyer does not belong to its state', error_source: 'IRP' },
      ],
    }));
    const err = await PROVIDERS.cleartax(cfg()).register(INV01).catch((e) => e);
    expect(err.code).toBe('EINVOICE_REJECTED');
    expect(err.statusCode ?? err.status).toBe(502);
    expect(err.message).toBe('ClearTax did not register it: 2172: Buyer GSTIN is invalid; 2211: Pincode of buyer does not belong to its state.');
  });

  it('a duplicate at the portal (2150) says to paste the IRN in', async () => {
    fetchMock.mockResolvedValue(reply({ Success: 'N', ErrorDetails: [{ error_code: '2150', error_message: 'Duplicate IRN' }] }));
    const err = await PROVIDERS.cleartax(cfg()).register(INV01).catch((e) => e);
    expect(err.message).toMatch(/^ClearTax did not register it: 2150: Duplicate IRN\./);
    expect(err.message).toMatch(/paste it in from the portal or ClearTax/);
  });

  it('a wrong token is said with the HTTP status', async () => {
    fetchMock.mockResolvedValue(reply({ error_message: 'Invalid auth token' }, 401));
    const err = await PROVIDERS.cleartax(cfg()).register(INV01).catch((e) => e);
    expect(err.message).toBe('ClearTax did not register it (401): Invalid auth token.');
  });

  it('no answer is said so, with a warning that it may have gone through', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    const err = await PROVIDERS.cleartax(cfg()).register(INV01).catch((e) => e);
    expect(err.message).toMatch(/did not answer in time.*may have gone through/);
  });
});

describe('the token goes to ClearTax only', () => {
  it.each([
    ['an address left from another GSP', 'https://gsp.example/api'],
    ['a look-alike', 'https://api.clear.in.evil.example'],
    ['plain http', 'http://api.clear.in'],
  ])('not to %s', async (_what, baseUrl) => {
    const err = await PROVIDERS.cleartax(cfg({ baseUrl })).register(INV01).catch((e) => e);
    expect(err.code).toBe('EINVOICE_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nor without a token, nor without the GSTIN', async () => {
    expect((await PROVIDERS.cleartax(cfg({ clientSecret: '' })).register(INV01).catch((e) => e)).message).toMatch(/No ClearTax auth token/);
    expect((await PROVIDERS.cleartax(cfg({ gstin: '' })).register(INV01).catch((e) => e)).message).toMatch(/GSTIN is missing/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('cancel and e-way bill through ClearTax', () => {
  it('cancels the IRN with the reason as the remark', async () => {
    fetchMock.mockResolvedValue(reply({ Success: 'Y', Irn: IRN, CancelDate: '2026-11-13 18:00:00' }));
    const r = await PROVIDERS.cleartax(cfg()).cancel(IRN, { reason: 'raised against the wrong challan' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-sandbox.clear.in/einv/v1/govt/api/Cancel');
    expect(JSON.parse(init.body)).toEqual({ irn: IRN, CnlRsn: '4', CnlRem: 'raised against the wrong challan' });
    expect(r.cancelledAt.toISOString()).toBe('2026-11-13T12:30:00.000Z');
  });

  it('a refused cancel says why', async () => {
    fetchMock.mockResolvedValue(reply({ Success: 'N', ErrorDetails: [{ error_code: '2270', error_message: 'The allowed cancellation time limit is crossed' }] }));
    const err = await PROVIDERS.cleartax(cfg()).cancel(IRN, { reason: 'x' }).catch((e) => e);
    expect(err.message).toBe('ClearTax refused the cancellation: 2270: The allowed cancellation time limit is crossed.');
  });

  it('generates the e-way bill from the IRN', async () => {
    fetchMock.mockResolvedValue(reply({ Irn: IRN, EwbNo: 391001234567, EwbDt: '2026-11-13 11:00:00', EwbValidTill: '2026-11-14 23:59:00', EwbStatus: 'GENERATED' }));
    const ewb = { Irn: IRN, Distance: 120, TransMode: '1', VehNo: 'TN39BX1234', VehType: 'R' };
    const r = await PROVIDERS.cleartax(cfg()).ewaybill(ewb);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-sandbox.clear.in/einv/v1/govt/api/einvewb/ewaybill');
    expect(JSON.parse(init.body)).toEqual(ewb);
    expect(r).toMatchObject({ number: '391001234567' });
    expect(r.generatedAt.toISOString()).toBe('2026-11-13T05:30:00.000Z');
    expect(r.validUpto.toISOString()).toBe('2026-11-14T18:29:00.000Z');
  });

  it('a failed e-way bill says why', async () => {
    fetchMock.mockResolvedValue(reply({ EwbStatus: 'FAILED', ErrorDetails: [{ error_code: '4002', error_message: 'EwayBill is already generated for this IRN' }] }));
    const err = await PROVIDERS.cleartax(cfg()).ewaybill({ Irn: IRN }).catch((e) => e);
    expect(err.code).toBe('EWB_REJECTED');
    expect(err.message).toBe('ClearTax did not generate the e-way bill: 4002: EwayBill is already generated for this IRN.');
  });
});
