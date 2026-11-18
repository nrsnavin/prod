'use strict';
// ══════════════════════════════════════════════════════════════════
//  A GSTIN, AS THE GST SYSTEM DESCRIBES IT
//
//  "Verify" beside the GSTIN on a customer or supplier form asks a
//  provider what the GST system holds, and the answer fills the form.
//  Providers send one of two layouts — the e-invoice system's and the
//  common portal's — sometimes wrapped, sometimes as a string of JSON.
//
//    • either layout reads into the same record: names, status, type,
//      dates, and the address as the form's fields
//    • the state is the GSTIN's own first two digits, whatever the reply
//      calls it
//    • "no such date" (1900-01-01) is no date
//    • the one line the form shows says the status in plain words, and
//      says so plainly when the registration is cancelled
//    • what the form takes: the name the business is known by (the legal
//      name beside it), street, city, PIN, state, PAN, and whether it is
//      a composition dealer
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';

const { normalise, local, messageFor, fillFrom, FRESH_MS } = require('../../services/gstinLookup');

const GSTIN = '33AAECB1234F1ZC';

/** The e-invoice system's "Get GSTIN details", as it is documented. */
const NIC = {
  Gstin: GSTIN, TradeName: 'Sunrise Garments', LegalName: 'SUNRISE GARMENTS PRIVATE LIMITED',
  AddrBnm: 'Sunrise Towers', AddrBno: '12/4', AddrFlno: '2nd Floor', AddrSt: 'Avinashi Road', AddrLoc: 'Tiruppur',
  StateCode: 33, AddrPncd: 641603, TxpType: 'REG', Status: 'ACT', BlkStatus: 'U', DtReg: '2017-07-01', DtDReg: '1900-01-01',
};

/** The common portal's taxpayer search. */
const PORTAL = {
  gstin: GSTIN, lgnm: 'SUNRISE GARMENTS PRIVATE LIMITED', tradeNam: 'Sunrise Garments', sts: 'Active',
  dty: 'Regular', ctb: 'Private Limited Company', rgdt: '01/07/2017', cxdt: '',
  pradr: { addr: { bno: '12/4', flno: '2nd Floor', bnm: 'Sunrise Towers', st: 'Avinashi Road', loc: 'Gandhi Nagar', dst: 'Tiruppur', city: '', stcd: 'Tamil Nadu', pncd: '641603' }, ntr: 'Factory / Manufacturing' },
};

describe('the check made here, with no call to anyone', () => {
  it('reads the state, the PAN and the check character from the number itself', () => {
    expect(local(' 33aaecb1234f1zc ')).toEqual({ gstin: GSTIN, valid: true, checksumOk: true, stateCode: '33', stateName: 'Tamil Nadu', pan: 'AAECB1234F' });
  });

  it('a wrong last character is a number that cannot exist', () => {
    expect(local('33AAECB1234F1Z5')).toMatchObject({ valid: true, checksumOk: false });
  });

  it('anything that is not fifteen characters in the pattern is not a GSTIN', () => {
    for (const bad of ['', '33AAECB1234F1Z', 'AAECB1234F', '33AAECB1234F1ZCC', null]) {
      expect(local(bad).valid).toBe(false);
    }
  });

  it('a second click is answered from the kept answer for fifteen minutes', () => {
    expect(FRESH_MS).toBe(15 * 60 * 1000);
  });
});

describe('the e-invoice system\'s layout', () => {
  it('reads names, status, type, dates and the address', () => {
    expect(normalise(NIC, GSTIN)).toEqual({
      gstin: GSTIN,
      legalName: 'SUNRISE GARMENTS PRIVATE LIMITED',
      tradeName: 'Sunrise Garments',
      status: 'active',
      taxpayerType: 'Regular',
      composition: false,
      sez: false,
      registeredOn: '2017-07-01',
      cancelledOn: '', // 1900-01-01 is the system's "no such date"
      einvoiceBlocked: false,
      address: { line: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road', locality: '', city: 'Tiruppur', district: '', state: 'Tamil Nadu', stateCode: '33', pincode: '641603' },
    });
  });

  it('reads the status codes', () => {
    const status = (Status) => normalise({ ...NIC, Status }, GSTIN).status;
    expect(status('ACT')).toBe('active');
    expect(status('CNL')).toBe('cancelled');
    expect(status('SUS')).toBe('suspended');
    expect(status('INA')).toBe('inactive');
    expect(status('PRO')).toBe('provisional');
    expect(status('')).toBe('unknown');
    expect(status('???')).toBe('unknown');
  });

  it('reads the taxpayer types: composition, SEZ', () => {
    expect(normalise({ ...NIC, TxpType: 'COM' }, GSTIN)).toMatchObject({ taxpayerType: 'Composition', composition: true, sez: false });
    expect(normalise({ ...NIC, TxpType: 'SEZ' }, GSTIN)).toMatchObject({ taxpayerType: 'SEZ unit', composition: false, sez: true });
    expect(normalise({ ...NIC, TxpType: 'SED' }, GSTIN)).toMatchObject({ taxpayerType: 'SEZ developer', sez: true });
  });

  it('says when it is blocked from e-invoicing, and nothing when the flag is not sent', () => {
    expect(normalise({ ...NIC, BlkStatus: 'B' }, GSTIN).einvoiceBlocked).toBe(true);
    const { BlkStatus, ...without } = NIC;
    expect(normalise(without, GSTIN).einvoiceBlocked).toBeNull();
  });

  it('reads a cancelled registration with the date it ended', () => {
    expect(normalise({ ...NIC, Status: 'CNL', DtDReg: '2024-03-12' }, GSTIN)).toMatchObject({ status: 'cancelled', cancelledOn: '2024-03-12' });
  });

  it('finds it inside the wrappers providers use, and inside a string of JSON', () => {
    const want = normalise(NIC, GSTIN);
    expect(normalise({ Status: 1, Data: NIC, ErrorDetails: null, InfoDtls: null }, GSTIN)).toEqual(want);
    expect(normalise({ success: true, data: { result: NIC } }, GSTIN)).toEqual(want);
    expect(normalise({ Status: 1, Data: JSON.stringify(NIC) }, GSTIN)).toEqual(want);
    expect(normalise(JSON.stringify({ data: NIC }), GSTIN)).toEqual(want);
    expect(normalise([NIC], GSTIN)).toEqual(want);
  });

  it('a PIN that is not six digits is left out, not guessed', () => {
    expect(normalise({ ...NIC, AddrPncd: 6416 }, GSTIN).address.pincode).toBe('');
    expect(normalise({ ...NIC, AddrPncd: '641 603' }, GSTIN).address.pincode).toBe('641603');
  });

  it('a building name repeated as the street is said once', () => {
    expect(normalise({ ...NIC, AddrBno: '', AddrFlno: '', AddrBnm: 'Avinashi Road', AddrSt: 'AVINASHI ROAD' }, GSTIN).address.line).toBe('Avinashi Road');
  });
});

describe('the common portal\'s layout', () => {
  it('reads the same record, with the district as the city and the locality kept', () => {
    expect(normalise(PORTAL, GSTIN)).toEqual({
      gstin: GSTIN,
      legalName: 'SUNRISE GARMENTS PRIVATE LIMITED',
      tradeName: 'Sunrise Garments',
      status: 'active',
      taxpayerType: 'Regular',
      composition: false,
      sez: false,
      registeredOn: '2017-07-01', // written dd/mm/yyyy there
      cancelledOn: '',
      einvoiceBlocked: null, // not something the portal's search says
      address: { line: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road', locality: 'Gandhi Nagar', city: 'Tiruppur', district: '', state: 'Tamil Nadu', stateCode: '33', pincode: '641603' },
    });
  });

  it('a city, where one is given, is the city and the district is kept beside it', () => {
    const got = normalise({ ...PORTAL, pradr: { addr: { ...PORTAL.pradr.addr, city: 'Avinashi' } } }, GSTIN);
    expect(got.address).toMatchObject({ city: 'Avinashi', district: 'Tiruppur', locality: 'Gandhi Nagar' });
  });

  it('reads the statuses and types written as words', () => {
    expect(normalise({ ...PORTAL, sts: 'Cancelled', cxdt: '12/03/2024' }, GSTIN)).toMatchObject({ status: 'cancelled', cancelledOn: '2024-03-12' });
    expect(normalise({ ...PORTAL, sts: 'Suspended' }, GSTIN).status).toBe('suspended');
    expect(normalise({ ...PORTAL, dty: 'Composition' }, GSTIN)).toMatchObject({ taxpayerType: 'Composition', composition: true });
    expect(normalise({ ...PORTAL, dty: 'SEZ Unit' }, GSTIN).sez).toBe(true);
  });

  it('is found inside "data" and "result", and when the address is missing altogether', () => {
    expect(normalise({ error: false, data: PORTAL }, GSTIN)).toEqual(normalise(PORTAL, GSTIN));
    expect(normalise({ result: PORTAL }, GSTIN)).toEqual(normalise(PORTAL, GSTIN));
    const { pradr, ...bare } = PORTAL;
    expect(normalise(bare, GSTIN).address).toEqual({ line: '', locality: '', city: '', district: '', state: 'Tamil Nadu', stateCode: '33', pincode: '' });
  });
});

describe('the same registration, spelled another way', () => {
  const want = () => normalise(NIC, GSTIN);

  it('camelCase, as some GSPs send the e-invoice system\'s answer', () => {
    const camel = {
      gstin: GSTIN, tradeName: 'Sunrise Garments', legalName: 'SUNRISE GARMENTS PRIVATE LIMITED', addrBnm: 'Sunrise Towers', addrBno: '12/4',
      addrFlno: '2nd Floor', addrSt: 'Avinashi Road', addrLoc: 'Tiruppur', stateCode: 33, addrPncd: 641603, txpType: 'REG', status: 'ACT',
      blkStatus: 'U', dtReg: '2017-07-01', dtDReg: '1900-01-01',
    };
    expect(normalise(camel, GSTIN)).toEqual(want());
  });

  it('snake_case, with the address spelled out', () => {
    const snake = {
      gstin: GSTIN, trade_name: 'Sunrise Garments', legal_name: 'SUNRISE GARMENTS PRIVATE LIMITED', address_building_name: 'Sunrise Towers',
      address_building_number: '12/4', address_floor_number: '2nd Floor', address_street: 'Avinashi Road', address_location: 'Tiruppur',
      state_code: 33, address_pincode: 641603, taxpayer_type: 'REG', status: 'ACT', block_status: 'U', date_of_registration: '2017-07-01',
      date_of_deregistration: null,
    };
    expect(normalise(snake, GSTIN)).toEqual(want());
  });

  it('what the e-invoice system leaves empty is empty, not a value', () => {
    // As its own samples show them: no trade name, no date, a PIN of 0, no block flag.
    const sparse = normalise({ ...NIC, TradeName: null, DtReg: null, DtDReg: null, AddrPncd: 0, BlkStatus: null }, GSTIN);
    expect(sparse).toMatchObject({ tradeName: '', registeredOn: '', cancelledOn: '', einvoiceBlocked: null });
    expect(sparse.address.pincode).toBe('');
    expect(fillFrom({ gstin: GSTIN, found: true, ...sparse }).name).toBe('SUNRISE GARMENTS PRIVATE LIMITED');
  });

  it('an envelope that repeats the GSTIN with a status of its own does not hide what it wraps', () => {
    const got = normalise({ gstin: GSTIN, status: 'success', code: 200, data: NIC }, GSTIN);
    expect(got).toEqual(want());
    // …and one with nothing inside is still read for what it is.
    expect(normalise({ gstin: GSTIN, status: 'Active', pincode: '641603' }, GSTIN)).toMatchObject({ status: 'active', legalName: '', address: { pincode: '641603' } });
  });

  it('an address that comes as one piece of text is the address, and is not said twice', () => {
    const got = normalise({ gstin: GSTIN, lgnm: 'SUNRISE GARMENTS PRIVATE LIMITED', sts: 'Active', pradr: { adr: '12/4, Avinashi Road, Tiruppur, Tamil Nadu, 641603' } }, GSTIN);
    expect(got.address).toMatchObject({ line: '12/4, Avinashi Road, Tiruppur, Tamil Nadu, 641603', city: '', pincode: '', state: 'Tamil Nadu' });
    expect(fillFrom({ gstin: GSTIN, found: true, ...got })).toMatchObject({
      address: '12/4, Avinashi Road, Tiruppur, Tamil Nadu, 641603',
      fullAddress: '12/4, Avinashi Road, Tiruppur, Tamil Nadu, 641603', // the state is already in it
    });
    const flat = normalise({ gstin: GSTIN, legalName: 'SUNRISE', status: 'ACT', address: '12/4, Avinashi Road', city: 'Tiruppur', pincode: '641603' }, GSTIN);
    expect(flat.address).toMatchObject({ line: '12/4, Avinashi Road', city: 'Tiruppur', pincode: '641603' });
  });

  it('a lookup service\'s own spelling: hyphenated keys, and the address in a block called "adress"', () => {
    // The keys as one such service's page shows them (KnowYourGST).
    const got = normalise({
      status: 'Active', 'registration-date': '01/07/2017', business: ['Manufacturer'], gstin: GSTIN, 'dealer-type': 'Regular',
      'trade-name': 'Sunrise Garments', 'entity-type': 'Private Limited Company', pan: 'AAECB1234F', 'legal-name': 'SUNRISE GARMENTS PRIVATE LIMITED',
      adress: { lg: '', bname: 'Sunrise Towers', street: 'Avinashi Road', bno: '12/4', location: 'Tiruppur', lt: '', floor: '2nd Floor', state: 'Tamil Nadu', pincode: '641603' },
    }, GSTIN);
    // The same registration as the e-invoice system gives — bar the block flag, which only that system has.
    expect(got).toEqual({ ...want(), einvoiceBlocked: null });
    expect(fillFrom({ gstin: GSTIN, found: true, ...got })).toMatchObject({
      name: 'Sunrise Garments', address: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road', city: 'Tiruppur', pincode: '641603', stateCode: '33',
      fullAddress: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road, Tiruppur, Tamil Nadu - 641603', gstRegistration: 'regular',
    });
    const composition = normalise({ gstin: GSTIN, 'legal-name': 'X', status: 'Active', 'dealer-type': 'Composition' }, GSTIN);
    expect(composition).toMatchObject({ taxpayerType: 'Composition', composition: true });
  });

  it('a town repeated in the street is said once in the one-line address', () => {
    const got = normalise({ ...NIC, AddrSt: 'Avinashi Road, Tiruppur' }, GSTIN);
    expect(fillFrom({ gstin: GSTIN, found: true, ...got }).fullAddress).toBe('12/4, 2nd Floor, Sunrise Towers, Avinashi Road, Tiruppur, Tamil Nadu - 641603');
  });
});

describe('what is not a taxpayer', () => {
  it('is nothing: an error, an empty reply, a page of text', () => {
    for (const body of [
      null, undefined, {}, [], '', 'Not Found', '<html></html>', { success: false, message: 'Invalid GSTIN' },
      { Status: 0, ErrorDetails: [{ ErrorCode: '3001', ErrorMessage: 'Requested data is not available' }], Data: null },
      // An envelope about the call, with the number echoed: not a registration.
      { gstin: GSTIN, message: 'Invalid token' }, { status: 'error', data: null }, { status: 401, error: 'Unauthorized' },
    ]) {
      expect(normalise(body, GSTIN)).toBeNull();
    }
  });

  it('the state is the GSTIN\'s own, whatever the reply calls it', () => {
    expect(normalise({ ...NIC, StateCode: 29 }, GSTIN).address).toMatchObject({ stateCode: '33', state: 'Tamil Nadu' });
  });
});

describe('the line the form shows', () => {
  const row = (over = {}) => ({ gstin: GSTIN, found: true, ...normalise(NIC, GSTIN), ...over });

  it('active: both names, once each', () => {
    expect(messageFor(row())).toBe('Active on the GST portal: SUNRISE GARMENTS PRIVATE LIMITED (trade name Sunrise Garments).');
    expect(messageFor(row({ tradeName: 'sunrise garments private limited' }))).toBe('Active on the GST portal: SUNRISE GARMENTS PRIVATE LIMITED.');
    expect(messageFor(row({ legalName: '' }))).toBe('Active on the GST portal: Sunrise Garments.');
  });

  it('cancelled: says so, since when, and what it means', () => {
    expect(messageFor(row({ status: 'cancelled', cancelledOn: '2024-03-12' })))
      .toBe('Cancelled on the GST portal since 12 Mar 2024: SUNRISE GARMENTS PRIVATE LIMITED (trade name Sunrise Garments). It is no longer a registered party.');
    expect(messageFor(row({ status: 'cancelled', cancelledOn: '' }))).toMatch(/^Cancelled on the GST portal: /);
  });

  it('suspended, inactive, provisional and not given', () => {
    expect(messageFor(row({ status: 'suspended' }))).toMatch(/^Suspended on the GST portal: .* Check with them before billing or buying on this number\.$/);
    expect(messageFor(row({ status: 'inactive' }))).toMatch(/^Inactive on the GST portal: /);
    expect(messageFor(row({ status: 'provisional' }))).toMatch(/^Provisionally registered on the GST portal: /);
    expect(messageFor(row({ status: 'unknown' }))).toMatch(/Its status was not given\.$/);
  });

  it('not found: the provider\'s own words, not "it does not exist"', () => {
    expect(messageFor({ gstin: GSTIN, found: false, said: '3001: Requested data is not available' }))
      .toBe(`No registration came back for ${GSTIN} from the GST portal — it said: 3001: Requested data is not available.`);
    expect(messageFor({ gstin: GSTIN, found: false, said: 'No records found.' }))
      .toBe(`No registration came back for ${GSTIN} from the GST portal — it said: No records found.`);
    expect(messageFor({ gstin: GSTIN, found: false, said: '' })).toBe(`No registration came back for ${GSTIN} from the GST portal.`);
  });
});

describe('what the form takes', () => {
  const row = (body, over = {}) => ({ gstin: GSTIN, found: true, ...normalise(body, GSTIN), ...over });

  it('the name it is known by, the legal name beside it, and the address in the form\'s fields', () => {
    expect(fillFrom(row(PORTAL))).toEqual({
      name: 'Sunrise Garments',
      legalName: 'SUNRISE GARMENTS PRIVATE LIMITED',
      tradeName: 'Sunrise Garments',
      address: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road, Gandhi Nagar',
      city: 'Tiruppur',
      pincode: '641603',
      stateCode: '33',
      fullAddress: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road, Gandhi Nagar, Tiruppur, Tamil Nadu - 641603',
      pan: 'AAECB1234F',
      gstRegistration: 'regular',
      sez: false,
    });
  });

  it('the legal name when there is no trade name', () => {
    expect(fillFrom(row({ ...NIC, TradeName: '' })).name).toBe('SUNRISE GARMENTS PRIVATE LIMITED');
  });

  it('a composition dealer is marked as one (no input credit on their bills)', () => {
    expect(fillFrom(row({ ...NIC, TxpType: 'COM' })).gstRegistration).toBe('composition');
  });

  it('the one-line address holds the district when the city is a town in it', () => {
    const got = fillFrom(row({ ...PORTAL, pradr: { addr: { ...PORTAL.pradr.addr, city: 'Avinashi' } } }));
    expect(got.city).toBe('Avinashi');
    expect(got.fullAddress).toBe('12/4, 2nd Floor, Sunrise Towers, Avinashi Road, Gandhi Nagar, Avinashi, Tiruppur, Tamil Nadu - 641603');
  });

  it('nothing when no registration came back', () => {
    expect(fillFrom({ gstin: GSTIN, found: false })).toBeNull();
  });

  it('the state and PAN come from the number even when the address is empty', () => {
    const { pradr, ...bare } = PORTAL;
    expect(fillFrom(row(bare))).toMatchObject({ stateCode: '33', pan: 'AAECB1234F', address: '', city: '', pincode: '', fullAddress: 'Tamil Nadu' });
  });
});
