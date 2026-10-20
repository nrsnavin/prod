'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE CUSTOMER'S NUMBER, FROM A PO OR A WHATSAPP ENQUIRY SCREENSHOT
//
//  In a chat screenshot the number is typed into the message box before
//  the screenshot is taken. That box is read first, the chat header
//  second, and only then whatever number the reading named. The one
//  number is the customer's mobile and their WhatsApp number both.
//
//  The model is stubbed: what is tested is what the code asks for and
//  what it does with the reply.
// ══════════════════════════════════════════════════════════════════

const mockCreate = jest.fn();
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }),
  VISION_MODEL: 'vision-x',
}));

const {
  normaliseDraft, phoneIn, phoneKey, isMobile, extractPurchaseOrder, OUTPUT_SCHEMA, SOURCE_TYPES,
} = require('../../utils/inboundPoOcr');

const chat = (over = {}) => ({
  sourceType: 'whatsapp_chat',
  messageBoxText: '+91 97874 98412',
  chatHeaderTitle: 'Fellows Fashion Va...',
  customerName: 'Fellows Fashion Va...',
  customerPhone: null,
  poNumber: null, poDate: null, deliveryDate: null, currency: null,
  lines: [{ description: 'Jogger', quantity: 2350, unit: null, rate: null, confidence: 0.8 }],
  notes: '', confidence: 0.8,
  ...over,
});
const reply = (obj, over = {}) => ({
  stop_reason: 'end_turn',
  usage: { input_tokens: 1000, output_tokens: 100 },
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  ...over,
});

beforeEach(() => mockCreate.mockReset());

describe('where the number comes from', () => {
  test('the message box of a chat, as the mobile and the WhatsApp number both', () => {
    const d = normaliseDraft(chat());
    expect(d).toMatchObject({
      sourceType: 'whatsapp_chat',
      customerMobile: '+91 97874 98412',
      customerWhatsapp: '+91 97874 98412',
      phoneSource: 'message_box',
    });
  });

  test('the message box wins over a number the reading named elsewhere', () => {
    const d = normaliseDraft(chat({ customerPhone: '+91 90000 11111' }));
    expect(d.customerMobile).toBe('+91 97874 98412');
  });

  test('a number with words around it in the box is still found', () => {
    const d = normaliseDraft(chat({ messageBoxText: 'Fellows no: 97874-98412 pls save' }));
    expect(d).toMatchObject({ customerMobile: '97874-98412', phoneSource: 'message_box' });
  });

  test('an empty box falls back to a number in the chat header', () => {
    const d = normaliseDraft(chat({ messageBoxText: null, chatHeaderTitle: '+91 97874 98412' }));
    expect(d).toMatchObject({ customerMobile: '+91 97874 98412', phoneSource: 'chat_header' });
  });

  test('then to a number the customer wrote in a message', () => {
    const d = normaliseDraft(chat({ messageBoxText: 'Message', customerPhone: '98432 10987' }));
    expect(d).toMatchObject({ customerMobile: '98432 10987', customerWhatsapp: '98432 10987', phoneSource: 'chat_message' });
  });

  test('a document takes the number from its letterhead or signature', () => {
    const d = normaliseDraft(chat({ sourceType: 'document', messageBoxText: null, chatHeaderTitle: null, customerPhone: '0421-2345678' }));
    expect(d).toMatchObject({ sourceType: 'document', customerMobile: '0421-2345678', phoneSource: 'document' });
  });

  test('no number anywhere is null, not a guess', () => {
    const d = normaliseDraft(chat({ messageBoxText: null, chatHeaderTitle: 'Fellows', customerPhone: 'PO-8891' }));
    expect(d).toMatchObject({ customerMobile: null, customerWhatsapp: null, phoneSource: null });
  });
});

describe('an email screenshot or a visiting card', () => {
  const card = (over = {}) => chat({
    sourceType: 'visiting_card', messageBoxText: null, chatHeaderTitle: null,
    customerName: 'Fellows Fashion Ventures', contactPerson: 'Mohan Raj',
    customerEmail: 'Mohan@FellowsFashion.in', customerPhone: null, lines: [],
    phoneNumbers: [
      { number: '0421-2345678', label: 'Off' },
      { number: '+91 97874 98412', label: 'Mob' },
    ],
    ...over,
  });

  test('a card gives its mobile as the mobile and WhatsApp number, not the office line', () => {
    const d = normaliseDraft(card());
    expect(d).toMatchObject({
      sourceType: 'visiting_card', contactPerson: 'Mohan Raj', customerEmail: 'mohan@fellowsfashion.in',
      customerMobile: '+91 97874 98412', customerWhatsapp: '+91 97874 98412', phoneSource: 'visiting_card',
    });
    expect(d.phoneNumbers).toHaveLength(2);
    expect(d.lines).toEqual([]);
  });

  test('a number marked WhatsApp wins over one marked mobile', () => {
    const d = normaliseDraft(card({ phoneNumbers: [
      { number: '98432 10987', label: 'Mob' }, { number: '97874 98412', label: 'WhatsApp' },
    ] }));
    expect(d.customerWhatsapp).toBe('97874 98412');
    expect(d.customerMobile).toBe('97874 98412');
  });

  test('unlabelled, a mobile-looking number wins over a landline', () => {
    const d = normaliseDraft(card({ phoneNumbers: [
      { number: '0421 2345678', label: null }, { number: '9787498412', label: null },
    ] }));
    expect(d.customerMobile).toBe('9787498412');
  });

  test("the reading's own pick stands, unless it is a landline and a mobile was listed", () => {
    expect(normaliseDraft(card({ customerPhone: '98432 10987' })).customerMobile).toBe('98432 10987');
    expect(normaliseDraft(card({ customerPhone: '0421-2345678' })).customerMobile).toBe('+91 97874 98412');
  });

  test("an email's sender address and signature number are taken", () => {
    const d = normaliseDraft(card({
      sourceType: 'email', customerEmail: 'Purchase <purchase@fellows.in>',
      phoneNumbers: [{ number: 'M: 97874 98412', label: 'M' }],
    }));
    expect(d).toMatchObject({ sourceType: 'email', customerEmail: 'purchase@fellows.in', customerMobile: '97874 98412', phoneSource: 'email' });
  });

  test('an unknown kind is read as a document', () => {
    expect(normaliseDraft(card({ sourceType: 'fax' })).sourceType).toBe('document');
  });

  test('a card or an email gets no second look at a message box', async () => {
    mockCreate.mockResolvedValueOnce(reply(card({ phoneNumbers: [] })));
    await extractPurchaseOrder(Buffer.from('x'), 'image/png');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

test('the prompt and schema name all four kinds', () => {
  expect(SOURCE_TYPES).toEqual(['whatsapp_chat', 'email', 'visiting_card', 'document']);
  expect(OUTPUT_SCHEMA.properties.sourceType.enum).toEqual(SOURCE_TYPES);
  expect(OUTPUT_SCHEMA.required).toEqual(expect.arrayContaining(['customerEmail', 'phoneNumbers', 'contactPerson']));
});

test('numbers are found in text and compared on their last ten digits', () => {
  expect(phoneIn('call +91 97874 98412 today')).toBe('+91 97874 98412');
  expect(phoneIn('Jogger-2350, Boys - 5810')).toBeNull();
  expect(phoneIn(null)).toBeNull();
  const k = phoneKey('9787498412');
  expect(phoneKey('+91 97874 98412')).toBe(k);
  expect(phoneKey('097874 98412')).toBe(k);
  expect(phoneKey('12345')).toBeNull();
  expect(isMobile('+91 97874 98412')).toBe(true);
  expect(isMobile('0421 2345678')).toBe(false);
});

describe('asking the model', () => {
  test('the reply is held to a schema that always carries the message box', async () => {
    mockCreate.mockResolvedValueOnce(reply(chat()));
    const r = await extractPurchaseOrder(Buffer.from('x'), 'image/png');
    const params = mockCreate.mock.calls[0][0];
    expect(params.output_config.format).toEqual({ type: 'json_schema', schema: OUTPUT_SCHEMA });
    expect(OUTPUT_SCHEMA.required).toEqual(expect.arrayContaining(['messageBoxText', 'chatHeaderTitle', 'sourceType']));
    expect(params.messages[0].content.at(-1).text).toMatch(/message input box/);
    expect(r.draft.customerMobile).toBe('+91 97874 98412');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('a chat read without its number gets a second, narrow look at the box', async () => {
    mockCreate
      .mockResolvedValueOnce(reply(chat({ messageBoxText: null })))
      .mockResolvedValueOnce(reply({ messageBoxText: '+91 97874 98412', chatHeaderTitle: 'Fellows Fashion Va...' },
        { usage: { input_tokens: 900, output_tokens: 20 } }));
    const r = await extractPurchaseOrder(Buffer.from('x'), 'image/png');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1][0].messages[0].content.at(-1).text).toMatch(/message input box/);
    expect(r.draft).toMatchObject({ customerMobile: '+91 97874 98412', customerWhatsapp: '+91 97874 98412', phoneSource: 'message_box' });
    // The order lines come from the first reading, untouched.
    expect(r.draft.lines[0]).toMatchObject({ description: 'Jogger', quantity: 2350 });
    expect(r.usage).toMatchObject({ input_tokens: 1900, output_tokens: 120 });
  });

  test('a failed second look leaves the reading standing, without a number', async () => {
    mockCreate
      .mockResolvedValueOnce(reply(chat({ messageBoxText: null })))
      .mockRejectedValueOnce(new Error('timeout'));
    const r = await extractPurchaseOrder(Buffer.from('x'), 'image/png');
    expect(r.ok).toBe(true);
    expect(r.draft.customerMobile).toBeNull();
  });

  test('a document is not asked twice', async () => {
    mockCreate.mockResolvedValueOnce(reply(chat({ sourceType: 'document', messageBoxText: null, chatHeaderTitle: null })));
    await extractPurchaseOrder(Buffer.from('x'), 'image/png');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('a refusal is an unreadable document, not a crash', async () => {
    mockCreate.mockResolvedValueOnce(reply({}, { stop_reason: 'refusal', content: [] }));
    const r = await extractPurchaseOrder(Buffer.from('x'), 'image/png');
    expect(r).toMatchObject({ available: true, ok: false });
  });
});
