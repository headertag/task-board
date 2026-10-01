import { readFileSync, statSync } from 'node:fs';

// Supply credentials issued by the authorized synthetic staging deployment.
// Prefer TEST_CREDENTIALS_PATH: a private, ignored JSON file containing
// {synthetic:true,ownerId,writeToken,readToken,otherOwnerId,otherWriteToken}.
// These tests need dedicated empty owners. Never use real task owners or data.
export function syntheticCredentials() {
  let values;
  if (process.env.TEST_CREDENTIALS_PATH) {
    try {
      if (statSync(process.env.TEST_CREDENTIALS_PATH).size > 100_000) throw new Error();
      values = JSON.parse(readFileSync(process.env.TEST_CREDENTIALS_PATH, 'utf8'));
    } catch { throw new Error('The private synthetic credentials file is missing or invalid'); }
  } else {
    values = {
      synthetic: process.env.TEST_SYNTHETIC === 'true',
      ownerId: process.env.TEST_OWNER_ID,
      writeToken: process.env.TEST_WRITE_TOKEN,
      readToken: process.env.TEST_READ_TOKEN,
      otherOwnerId: process.env.TEST_OTHER_OWNER_ID,
      otherWriteToken: process.env.TEST_OTHER_WRITE_TOKEN,
    };
  }
  if (!values || values.synthetic !== true) {
    throw new Error('Authorized synthetic staging credentials are required; set TEST_CREDENTIALS_PATH or TEST_SYNTHETIC=true with the explicit TEST_* credentials');
  }
  const owner = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  const token = value => typeof value === 'string' && value.length <= 16_384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
  if (!owner(values.ownerId) || !owner(values.otherOwnerId) || values.ownerId === values.otherOwnerId ||
    !token(values.writeToken) || !token(values.readToken) || !token(values.otherWriteToken) ||
    new Set([values.writeToken, values.readToken, values.otherWriteToken]).size !== 3) {
    throw new Error('Synthetic credentials require two distinct mapped owner IDs and distinct primary-write, primary-read and second-owner-write bearer tokens');
  }
  // JWT syntax here is only input validation. The Worker verifies all signatures,
  // claims, provider identities, allowlists and client write consent scopes.
  return values;
}

export function credentialHeaders(credentials, role = 'write', contentType = 'application/json') {
  const tokens = { write: credentials.writeToken, read: credentials.readToken, other: credentials.otherWriteToken };
  if (!tokens[role]) throw new Error('Unknown synthetic credential role');
  return { authorization: `Bearer ${tokens[role]}`, ...(contentType ? { 'content-type': contentType } : {}) };
}

export function assertSyntheticProbe(probe, credentials) {
  if (!probe || probe.version !== 2 || probe.synthetic !== true || probe.ownerId !== credentials.ownerId) {
    throw new Error('Persistence probe does not belong to the explicitly supplied synthetic owner; rerun the creation test with the matching credentials');
  }
  if (Object.keys(probe).some(key => /token|authorization|credential/i.test(key))) {
    throw new Error('Persistence probes must never contain authentication credentials');
  }
}
