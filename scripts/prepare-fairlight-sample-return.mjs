import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const liveRoutingHash = '9ac3513fe5a589284622a1e0c15f4633ef7791457b3fb7a828c872775844bab6';
const routingData = /(<<<'BM_HANDOFF_DATA'\r?\n)([^\r\n]+)(\r?\nBM_HANDOFF_DATA)/;
const storefrontScript = /<script id="bm-sample-return-v1">([\s\S]*?)<\/script>/;
const storefrontData = /(const data = )([^\r\n]+)(;\r?\n)/;
const colourSlugs = [
  ['Whisper', '1'], ['Oat', '2'], ['Mocha', '3'], ['Latte', '4'],
  ['Coconut', '5'], ['Cashew', '6'], ['Ash', '7'],
];

const fabrics = [
  {
    name: 'Fairlight Blockout', kind: 'blockout',
    sampleRange: ['6530c0f4d2c21', 'fsfbo'], sampleColour: ['fa2b0c071001a', 'fsbo'],
    blindRange: ['65b321ee84785', 'fairbo'], blindColour: ['fa1b0c260923a', 'fairbo'],
  },
  {
    name: 'Fairlight Light Filter', kind: 'lightfilter',
    sampleRange: ['6530c0f407c5d', 'fsflf'], sampleColour: ['fa2f1c071001b', 'fslf'],
    blindRange: ['651e6e5c9c67c', 'fairlf'], blindColour: ['fa1f1c260923b', 'fairlf'],
  },
  {
    name: 'Fairlight Sheer', kind: 'sunscreen',
    sampleRange: ['6530c0f4fbf9a', 'fsfsh'], sampleColour: ['fa25c071001c', 'fssh'],
    blindRange: ['651e703c25137', 'fairsh'], blindColour: ['fa15c260923c', 'fairsh'],
  },
];

function addFairlight(routing) {
  const product = routing.manifest.products[3839];
  assert.equal(product?.name, 'Everyday');
  assert.equal(routing.manifest.version, 1);

  for (const { name, kind, sampleRange, sampleColour, blindRange, blindColour } of fabrics) {
    const [rangeId, rangeSlug] = sampleRange;
    const [source, samplePrefix] = sampleColour;
    const [destination, blindPrefix] = blindColour;
    const range = routing.fields.find(field => field.id === rangeId);
    assert.ok(range?.choices.length, `Missing sample range field ${rangeId}`);
    assert.ok(!range.choices.some(choice => choice.slug === rangeSlug || choice.label === name));
    assert.ok(!routing.fields.some(field => field.id === source));
    range.choices.push({ label: name, slug: rangeSlug });
    routing.fields.push({
      id: source,
      label: `${name} Colours`,
      choices: colourSlugs.map(([label, suffix]) => ({ label, slug: samplePrefix + suffix })),
      conditionals: [{ rules: [{ condition: '==', value: rangeSlug, field: rangeId, generated: false }] }],
    });

    for (const [colour, suffix] of colourSlugs) {
      const choice = samplePrefix + suffix;
      const key = `3839:${source}:${choice}`;
      assert.ok(!routing.manifest.maps[key]);
      routing.manifest.maps[key] = {
        pid: 3839, source, choice, kind, range: name, colour,
        steps: [blindRange, [destination, blindPrefix + suffix]],
        labels: [name, colour],
      };
    }
  }
}

export function prepareFairlightSampleReturn(routingSource, renderedStorefront) {
  const routingMatch = routingSource.match(routingData);
  const storefront = renderedStorefront.match(storefrontScript)?.[1] ?? renderedStorefront;
  const storefrontMatch = storefront.match(storefrontData);
  assert.ok(routingMatch, 'Missing sample-routing data');
  assert.ok(storefrontMatch, 'Missing storefront return-link data');
  const routing = JSON.parse(routingMatch[2]);
  const originalStorefront = JSON.parse(storefrontMatch[2]);
  assert.deepEqual(originalStorefront, routing.manifest, 'Reconcile existing storefront and email maps first');

  addFairlight(routing);
  return {
    routing: routingSource.replace(routingData, (_, start, old, end) => start + JSON.stringify(routing) + end),
    storefront: storefront.replace(storefrontData, (_, start, old, end) => start + JSON.stringify(routing.manifest) + end),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [routingPath, storefrontPath, outputDirectory] = process.argv.slice(2);
  assert.ok(routingPath && storefrontPath && outputDirectory,
    'Usage: node scripts/prepare-fairlight-sample-return.mjs <routing-snippet.php> <storefront.html> <output-directory>');
  const routing = readFileSync(routingPath, 'utf8');
  const routingHash = createHash('sha256').update(routing).digest('hex');
  assert.equal(routingHash, liveRoutingHash, 'Expected the original live snippet source without redactions');
  const prepared = prepareFairlightSampleReturn(routing, readFileSync(storefrontPath, 'utf8'));
  writeFileSync(join(outputDirectory, 'fairlight-routing.php'), prepared.routing, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(outputDirectory, 'fairlight-storefront.js'), prepared.storefront, { flag: 'wx', mode: 0o600 });
}
