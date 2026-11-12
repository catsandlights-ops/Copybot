import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The pages' scripts must at least parse: one stray quote breaks the whole app window.
for (const page of ['ui/index.html', 'ui/phone.html', 'ui/guides.js']) {
  test(`${page}: its script parses`, () => {
    const text = fs.readFileSync(page, 'utf8');
    const scripts = page.endsWith('.js') ? [text] : [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length, 'has a script');
    for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code, { filename: page }));
  });
}
