'use strict';
// Accounting over reviewed evidence records, not a replacement for external verification.
const fs = require('node:fs');
const path = require('node:path');
const scopes = new Set(['DEV', 'LIVE', 'EXTERNAL', 'APPROVAL']);
function summarize(text) {
  const evidence = new Map();
  for (const line of text.split('\n')) {
    const m = /^(E\d+) = (DEV|LIVE|EXTERNAL|APPROVAL) ; .+ ; https:\/\/\S+/.exec(line);
    if (m) {
      if (evidence.has(m[1])) throw new Error('DUPLICATE_EVIDENCE');
      evidence.set(m[1], m[2]);
    }
  }
  const items = text.split('\n').filter(l => /^\|\s*\d+\s*\|/.test(l)).map(line => {
    const fields = line.split('|').slice(1, -1).map(s => s.trim());
    if (fields.length !== 6) throw new Error('INVALID_ROW');
    const [number, title, acceptance, scope, status, refs] = fields;
    if (!title || !acceptance || !scopes.has(scope) || !['DONE','OPEN','BLOCKED','VERIFYING'].includes(status)) throw new Error('INVALID_ROW');
    const proofs = refs === '-' ? [] : refs.split(',');
    for (const proof of proofs) if (!evidence.has(proof)) throw new Error('UNKNOWN_EVIDENCE');
    if (status === 'DONE' && (!proofs.length || !proofs.some(p => evidence.get(p) === scope))) throw new Error('EVIDENCE_SCOPE_MISMATCH');
    return { id: Number(number), title, acceptance, scope, status, evidence: proofs };
  });
  if (items.length !== 100 || items.some((r, i) => r.id !== i + 1)) throw new Error('EXACTLY_100_ORDERED_ITEMS_REQUIRED');
  const accepted = items.filter(r => r.status === 'DONE').length;
  const groups = Array.from({ length: 10 }, (_, i) => ({ from: i * 10 + 1, to: i * 10 + 10,
    accepted: items.slice(i * 10, i * 10 + 10).filter(r => r.status === 'DONE').length }));
  return { contract: 'LAUNCH_100_V1', accepted, remaining: 100 - accepted,
    checklistComplete: accepted === 100, commercialSuccessGuaranteed: false,
    evidenceVerification: 'OPERATOR_REVIEWED_RECORDS_NOT_ONLINE_REVERIFIED',
    notLaborPercentage: true, groups,
    incompleteIds: items.filter(r => r.status !== 'DONE').map(r => r.id) };
}
module.exports = { summarize };
if (require.main === module) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--require-launch')) throw new Error('INVALID_ARGUMENTS');
    const result = summarize(fs.readFileSync(path.resolve(__dirname, '../../docs/LAUNCH_100.ko.md'), 'utf8'));
    console.log(JSON.stringify(result, null, 2));
    if (process.argv[2] === '--require-launch' && !result.checklistComplete) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
