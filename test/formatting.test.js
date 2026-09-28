import assert from 'node:assert/strict';
import { test } from 'node:test';
import { telegramToMaxHtml } from '../src/formatting.js';

test('Telegram text and supported entities become escaped MAX HTML', () => {
  const text = 'A&B <x> https://example.org';
  const rendered = telegramToMaxHtml(text, [
    { type: 'bold', offset: 0, length: 3 },
    { type: 'url', offset: 8, length: 19 }
  ]);
  assert.equal(rendered, '<b>A&amp;B</b> &lt;x&gt; <a href="https://example.org">https://example.org</a>');
});

test('unsupported formatting leaves readable text and unsafe link has no HTML href', () => {
  const rendered = telegramToMaxHtml('click <me>', [
    { type: 'spoiler', offset: 0, length: 5 },
    { type: 'text_link', offset: 0, length: 5, url: 'javascript:alert(1)' }
  ]);
  assert.equal(rendered, 'click &lt;me&gt;');
});
