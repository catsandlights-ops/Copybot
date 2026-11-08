import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from './markets';

const rss = `<?xml version="1.0"?><rss><channel><title>Feed</title>
<item><title><![CDATA[Bitcoin & SOL rally]]></title><link>https://decrypt.co/1/story</link><pubDate>Sat, 08 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Phishing &lt;b&gt;link&lt;/b&gt;</title><link>https://evil.example/steal</link></item>
<item><title>Plain http</title><link>http://decrypt.co/2</link></item>
</channel></rss>`;

const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>BW</title>
<entry><title>Solana ETF flows</title><link rel="alternate" href="https://blockworks.com/news/sol-etf"/><published>2026-11-08T09:00:00Z</published></entry>
</feed>`;

test('RSS: decodes CDATA/entities, keeps only https links on the publisher host', () => {
  const items = parseFeed(rss, 'Decrypt', ['decrypt.co']);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Bitcoin & SOL rally');
  assert.equal(items[0].url, 'https://decrypt.co/1/story');
  assert.equal(items[0].publishedAt, Date.parse('2026-11-08T10:00:00Z'));
});

test('Atom: reads href links and published dates', () => {
  const items = parseFeed(atom, 'Blockworks', ['blockworks.com']);
  assert.deepEqual(items, [{ source: 'Blockworks', title: 'Solana ETF flows', url: 'https://blockworks.com/news/sol-etf', publishedAt: Date.parse('2026-11-08T09:00:00Z') }]);
});
