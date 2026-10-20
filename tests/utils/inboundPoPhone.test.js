'use strict';
// The customer's phone number, as the PO / enquiry reader returns it.
const { normaliseDraft, phoneKey } = require('../../utils/inboundPoOcr');

const phoneOf = (v) => normaliseDraft({ customerPhone: v, lines: [] }).customerPhone;

test('a number is kept as written', () => {
  expect(phoneOf('+91 97874 98412')).toBe('+91 97874 98412');
  expect(phoneOf(' 097874-98412 ')).toBe('097874-98412');
});

test('something that is not a phone number is dropped', () => {
  expect(phoneOf('PO-8891')).toBeNull();
  expect(phoneOf('12345')).toBeNull();
  expect(phoneOf('')).toBeNull();
  expect(phoneOf(null)).toBeNull();
  expect(phoneOf(undefined)).toBeNull();
});

test('the same number written differently compares equal', () => {
  const k = phoneKey('9787498412');
  expect(phoneKey('+91 97874 98412')).toBe(k);
  expect(phoneKey('097874 98412')).toBe(k);
  expect(phoneKey('12345')).toBeNull();
  expect(phoneKey(null)).toBeNull();
});
