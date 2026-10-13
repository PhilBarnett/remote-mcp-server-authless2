import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/equinox-pricing.ts'], bundle: true, format: 'esm', write: false });
const { EQUINOX_PRICING_PATHS, verifyEquinoxPricing, assertEquinoxPricingReadOnly } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
for (const path of EQUINOX_PRICING_PATHS) {
  assert.doesNotThrow(() => assertEquinoxPricingReadOnly(path, 'GET'));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.throws(() => assertEquinoxPricingReadOnly(path, method), /read-only/);
  assert.throws(() => assertEquinoxPricingReadOnly(path, 'GET', {}), /read-only/);
}
const payload = { plugin: { slug: 'blindmotion-wapf-pricing-bridge' }, read_only: true, write_performed: false, unrelated_values_returned: false, requested_lookup_names: ['alpha'], lookups: { alpha: { value_sha256: 'test' } } };
assert.equal(verifyEquinoxPricing(payload, ['alpha'], true), payload);
for (const patch of [{ read_only: false }, { write_performed: true }, { unrelated_values_returned: true }, { requested_lookup_names: ['other'] }, { lookups: { alpha: {}, extra: {} } }, { plugin: { slug: 'other' } }]) assert.throws(() => verifyEquinoxPricing({ ...payload, ...patch }, ['alpha'], true));
assert.throws(() => verifyEquinoxPricing({ ...payload, raw_values_returned: true }, [], false));
assert.doesNotThrow(() => verifyEquinoxPricing({ ...payload, raw_values_returned: false }, [], false));
console.log('Equinox pricing read-only and exact-selection tests passed');
