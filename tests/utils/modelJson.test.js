'use strict';
// The JSON in a model's reply (utils/modelJson.js): one reader for the
// thirteen that each had their own, reading what either kind of them read.

const { parseJson } = require('../../utils/modelJson');

describe('parseJson', () => {
  it('reads plain JSON, and JSON with a sentence either side', () => {
    expect(parseJson('{"kind":"complaint","urgent":true}')).toEqual({ kind: 'complaint', urgent: true });
    expect(parseJson('Here it is:\n{"kind":"order"}\nLet me know.')).toEqual({ kind: 'order' });
  });

  it('reads a fenced block, with or without the word json', () => {
    expect(parseJson('```json\n{"amount": 1200}\n```')).toEqual({ amount: 1200 });
    expect(parseJson('```\n{"amount": 1200}\n```')).toEqual({ amount: 1200 });
  });

  it('reads a fence that follows a sentence with a brace in it', () => {
    // First brace to last brace takes in "{name}" and fails.
    expect(parseJson('Using the {name} you gave:\n```json\n{"name":"Kumar Yarns"}\n```')).toEqual({ name: 'Kumar Yarns' });
  });

  it('reads the object outside a fence that holds something else', () => {
    // Looking only inside the fence finds no object.
    expect(parseJson('```text\nnot json\n```\n{"ok":true}')).toEqual({ ok: true });
  });

  it('keeps nested objects and braces inside strings', () => {
    expect(parseJson('{"a":{"b":[1,{"c":"}"}]}}')).toEqual({ a: { b: [1, { c: '}' }] } });
  });

  it.each([
    ['nothing', undefined], ['null', null], ['an empty reply', ''], ['prose', 'I could not read the photo.'],
    ['a brace that never closes', '{"a": 1'], ['closing before opening', '} then {'], ['broken JSON', '{"a": 1,}'],
    ['a number', 42], ['an object that is not text', { a: 1 }],
  ])('%s is null, never a throw', (_what, input) => {
    expect(parseJson(input)).toBeNull();
  });
});
