'use strict';

const {
  verifyTwilioSignature, parseCommand, twimlReply,
} = require('../../utils/whatsappInbound.js');

describe('whatsappInbound.parseCommand', () => {
  test('plain approve', () => {
    expect(parseCommand("APPROVE 1042"))
      .toEqual({ action: "approve", orderNo: 1042, force: false, forceReason: "" });
  });

  test('case-insensitive + extra whitespace', () => {
    expect(parseCommand("  approve   42  "))
      .toEqual({ action: "approve", orderNo: 42, force: false, forceReason: "" });
  });

  test('approve with force and colon reason', () => {
    expect(parseCommand("APPROVE 1042 force: customer escalation"))
      .toEqual({
        action: "approve", orderNo: 1042, force: true,
        forceReason: "customer escalation",
      });
  });

  test('approve with force and dash separator', () => {
    expect(parseCommand("approve 7 FORCE - rush, owner approved"))
      .toEqual({
        action: "approve", orderNo: 7, force: true,
        forceReason: "rush, owner approved",
      });
  });

  test('approve with force keyword and no separator', () => {
    expect(parseCommand("APPROVE 3 force urgent shipment"))
      .toEqual({
        action: "approve", orderNo: 3, force: true,
        forceReason: "urgent shipment",
      });
  });

  test('unknown command returns null', () => {
    expect(parseCommand("hello there")).toBeNull();
    expect(parseCommand("APPROVE")).toBeNull();
    expect(parseCommand("APPROVE abc")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });
});

describe('whatsappInbound.verifyTwilioSignature', () => {
  // Build the expected signature the way Twilio does, then verify
  // that our verifier accepts only that exact value.
  const crypto = require('crypto');

  const authToken = 'fake_auth_token_for_test';
  const url       = 'https://example.com/api/v2/notify/incoming';
  const body      = { From: 'whatsapp:+919876543210', Body: 'APPROVE 1042' };

  function signOf(b) {
    const sorted = Object.keys(b).sort();
    let data = url;
    for (const k of sorted) data += k + (b[k] ?? "");
    return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  }

  test('valid signature passes', () => {
    expect(verifyTwilioSignature({ url, body, signature: signOf(body), authToken }))
      .toBe(true);
  });

  test('wrong signature fails', () => {
    expect(verifyTwilioSignature({ url, body, signature: 'nope', authToken }))
      .toBe(false);
  });

  test('tampered body fails verification', () => {
    const evil = { ...body, Body: 'APPROVE 9999' };
    expect(verifyTwilioSignature({
      url, body: evil, signature: signOf(body), authToken,
    })).toBe(false);
  });

  test('missing inputs reject gracefully', () => {
    expect(verifyTwilioSignature({ url: '', body, signature: 'x', authToken })).toBe(false);
    expect(verifyTwilioSignature({ url, body, signature: '', authToken })).toBe(false);
    expect(verifyTwilioSignature({ url, body, signature: 'x', authToken: '' })).toBe(false);
  });
});

describe('whatsappInbound.twimlReply', () => {
  test('wraps a simple message', () => {
    const x = twimlReply("Hello!");
    expect(x).toMatch(/<\?xml/);
    expect(x).toMatch(/<Response>/);
    expect(x).toMatch(/<Message>Hello!<\/Message>/);
  });

  test('escapes XML special chars to avoid injection', () => {
    const x = twimlReply(`<script>alert('x')</script> & "more"`);
    expect(x).toMatch(/&lt;script&gt;/);
    expect(x).toMatch(/&amp;/);
    expect(x).toMatch(/&quot;/);
    expect(x).not.toMatch(/<script>/);
  });
});
