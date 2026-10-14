'use strict';

const { types } = require('pg');
const { createHash } = require('node:crypto');

// pg leaves PostgreSQL name[] (OID 1003) as text; PGlite returns an array.
// Use pg's existing text[] parser for the identical one-dimensional wire grammar.
// Do not split on commas, strip quotes, or sort composite key columns.
function identifierArray(value) {
  if (typeof value === 'string' && (!value.startsWith('{') || !value.endsWith('}'))) {
    throw new Error('INVALID_IDENTIFIER_ARRAY');
  }
  const parsed = typeof value === 'string'
    ? types.getTypeParser(1009, 'text')(value) : value;
  if (!Array.isArray(parsed) || parsed.some(v => typeof v !== 'string')) {
    throw new Error('INVALID_IDENTIFIER_ARRAY');
  }
  return [...parsed];
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  }
  return value;
}

function canonicalRows(rows) {
  if (!Array.isArray(rows)) throw new Error('INVALID_CATALOG_ROWS');
  return rows.map(row => {
    const normalized = { ...row };
    for (const key of ['columns', 'ref_columns']) {
      if (Object.hasOwn(normalized, key)) normalized[key] = identifierArray(normalized[key]);
    }
    // Catalog row/object order is irrelevant; column order, case, definitions,
    // FK pairing/actions, names and duplicate rows remain significant.
    return JSON.stringify(stable(normalized));
  }).sort();
}

function compareRows(expected, actual) {
  const a = canonicalRows(expected);
  const b = canonicalRows(actual);
  const equal = JSON.stringify(a) === JSON.stringify(b);
  return {
    equal,
    expectedCount: a.length,
    actualCount: b.length,
    expectedHash: createHash('sha256').update(JSON.stringify(a)).digest('hex'),
    actualHash: createHash('sha256').update(JSON.stringify(b)).digest('hex'),
    missing: a.filter(row => !b.includes(row)).map(JSON.parse),
    unexpected: b.filter(row => !a.includes(row)).map(JSON.parse),
  };
}

module.exports = { identifierArray, canonicalRows, compareRows };
