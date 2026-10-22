import { baselineCode } from './sample-routing-baseline';
import { releaseCode } from './sample-routing-release';

const origin = 'https://online.blindmotion.com.au';
const endpoint = origin + '/wp-json/code-snippets/v1/snippets/11';
const baselineHash = '6b471508329b3d9f4d888b819c27e8c435f721f54ac68ed726d7cd76df23e860';
export const routingConfirmation = 'CONFIRM UPDATE LIVE SAMPLE ROUTING';
type Input = { action: 'preview' | 'apply' | 'rollback'; expected_source_sha256?: string; expected_plan_sha256?: string; confirmation?: string };
type Snapshot = { id: number; code: string; active: boolean; name: string; scope: string; priority: number };
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}

// No caller-selected origin, ID, source code, activation, permissions or contact actions.
export async function updateSampleRouting(site: string, authorization: string, input: Input, request: typeof fetch = fetch) {
  if (site !== origin && site !== origin + '/') throw new Error('Exact live origin required.');
  if (!authorization) throw new Error('Configured WordPress authentication required.');
  if (await hash(baselineCode) !== baselineHash) throw new Error('Rollback snapshot integrity failed.');
  const releaseHash = await hash(releaseCode);
  async function read(): Promise<Snapshot> {
    const response = await request(endpoint, { method: 'GET', headers: { Authorization: authorization, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Routing read failed: HTTP ' + response.status);
    // Bound response bytes without logging source or remote error bodies.
    const reader = response.body?.getReader(); if (!reader) throw new Error('Empty routing response.');
    let text = ''; let size = 0; const decoder = new TextDecoder();
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 262144) throw new Error('Routing response too large.'); text += decoder.decode(part.value, { stream: true }); } text += decoder.decode(); } finally { await reader.cancel(); reader.releaseLock(); }
    const s = JSON.parse(text);
    if (s.id !== 11 || typeof s.code !== 'string' || s.active !== true || typeof s.name !== 'string' || typeof s.scope !== 'string' || typeof s.priority !== 'number' || !s.code.includes('final class BM_Sample_Routing_V103')) throw new Error('Routing identity or active state changed.');
    return { id: s.id, code: s.code, active: s.active, name: s.name, scope: s.scope, priority: s.priority };
  }
  async function write(code: string) {
    const response = await request(endpoint, { method: 'POST', headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Routing write failed: HTTP ' + response.status);
    await response.body?.cancel();
  }
  function sameSettings(a: Snapshot, b: Snapshot) { return a.id === b.id && a.active === b.active && a.name === b.name && a.scope === b.scope && a.priority === b.priority; }
  const before = await read(); const beforeHash = await hash(before.code);
  if (beforeHash !== baselineHash && beforeHash !== releaseHash) throw new Error('Unreviewed routing source; no write performed.');
  const targetCode = beforeHash === baselineHash ? releaseCode : baselineCode;
  const targetHash = await hash(targetCode);
  const direction = beforeHash === baselineHash ? 'apply' : 'rollback';
  const planHash = await hash(JSON.stringify({ endpoint, beforeHash, targetHash, settings: { ...before, code: undefined }, direction }));
  const result = { environment: 'live', snippet_id: 11, direction, source_sha256: beforeHash, target_sha256: targetHash, plan_sha256: planHash, backup_sha256: baselineHash, backup: 'Bundled reviewed v1.0.3 rollback snapshot', write_performed: false };
  if (input.action === 'preview') return result;
  if (input.action !== direction || input.confirmation !== routingConfirmation || input.expected_source_sha256 !== beforeHash || input.expected_plan_sha256 !== planHash) throw new Error('Exact preview and confirmation required; no write performed.');
  const fresh = await read();
  if (fresh.code !== before.code || !sameSettings(fresh, before)) throw new Error('Routing changed after preview; no write performed.');
  try {
    await write(targetCode);
    const after = await read();
    if (after.code !== targetCode || !sameSettings(after, before)) throw new Error('Routing read-back verification failed.');
    return { ...result, write_performed: true, verified: true };
  } catch {
    // An uncertain write is never repeated blindly. Never overwrite concurrent edits.
    try {
      const current = await read();
      if (current.code === before.code && sameSettings(current, before)) throw new Error('original');
      if (current.code !== targetCode || !sameSettings(current, before)) throw new Error('changed');
      await write(before.code);
      const restored = await read();
      if (restored.code !== before.code || !sameSettings(restored, before)) throw new Error('restore');
      return { ...result, write_performed: true, verified: false, rolled_back: true };
    } catch {
      const check = await read().catch(() => null);
      if (check && check.code === before.code && sameSettings(check, before)) return { ...result, verified: false, original_state_verified: true };
      throw new Error('Update could not be verified; automatic rollback unsafe or unsuccessful. Inspect snippet 11 before any further write.');
    }
  }
}
