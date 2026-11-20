'use strict';

// NWP-PRICE-007: Firecrawl API key loader. Runs with node:test; a fake Secrets Manager client is used, never AWS.

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createApiKeyProvider, parseSecretString } = require('../../src/pricing/firecrawl-secret');

// Stand-in for @aws-sdk/client-secrets-manager.
function fakeSecretsManager(secretString, { failTimes = 0 } = {}) {
  let calls = 0;
  const send = mock.fn(async (command) => {
    calls += 1;
    if (calls <= failTimes) throw new Error('AccessDeniedException');
    return { SecretString: secretString, requestedId: command.input.SecretId };
  });

  class GetSecretValueCommand {
    constructor(input) { this.input = input; }
  }
  class SecretsManagerClient {
    constructor() { this.send = send; }
  }

  return { module: { SecretsManagerClient, GetSecretValueCommand }, send };
}

describe('createApiKeyProvider', () => {
  test('uses FIRECRAWL_API_KEY locally, trimmed', async () => {
    const getApiKey = createApiKeyProvider({ env: { FIRECRAWL_API_KEY: '  fc-local  ' } });

    assert.equal(await getApiKey(), 'fc-local');
  });

  test('prefers the Secrets Manager secret when FIRECRAWL_SECRET_ARN is set', async () => {
    const arn = 'arn:aws:secretsmanager:ap-southeast-1:000000000000:secret:firecrawl';
    const sm = fakeSecretsManager('fc-from-secret');
    const getApiKey = createApiKeyProvider({
      env: { FIRECRAWL_SECRET_ARN: arn, FIRECRAWL_API_KEY: 'fc-local' },
      loadSecretsManager: () => sm.module,
    });

    assert.equal(await getApiKey(), 'fc-from-secret');
    assert.equal(sm.send.mock.callCount(), 1);
    assert.deepEqual(sm.send.mock.calls[0].arguments[0].input, { SecretId: arn });
  });

  test('reads the secret once and caches it', async () => {
    const sm = fakeSecretsManager('fc-from-secret');
    const getApiKey = createApiKeyProvider({ env: { FIRECRAWL_SECRET_ARN: 'arn:x' }, loadSecretsManager: () => sm.module });

    await getApiKey();
    await getApiKey();

    assert.equal(sm.send.mock.callCount(), 1);
  });

  test('does not cache a failed load', async () => {
    const sm = fakeSecretsManager('fc-from-secret', { failTimes: 1 });
    const getApiKey = createApiKeyProvider({ env: { FIRECRAWL_SECRET_ARN: 'arn:x' }, loadSecretsManager: () => sm.module });

    await assert.rejects(getApiKey(), /AccessDenied/);
    assert.equal(await getApiKey(), 'fc-from-secret');
    assert.equal(sm.send.mock.callCount(), 2);
  });

  test('fails clearly when nothing is configured', async () => {
    const getApiKey = createApiKeyProvider({ env: {} });

    await assert.rejects(getApiKey(), /FIRECRAWL_SECRET_ARN nor FIRECRAWL_API_KEY/);
  });

  test('does not load the AWS SDK when only the local key is set', async () => {
    const loadSecretsManager = mock.fn();
    const getApiKey = createApiKeyProvider({ env: { FIRECRAWL_API_KEY: 'fc-local' }, loadSecretsManager });

    await getApiKey();

    assert.equal(loadSecretsManager.mock.callCount(), 0);
  });
});

describe('parseSecretString', () => {
  test('accepts a plain key', () => {
    assert.equal(parseSecretString(' fc-plain '), 'fc-plain');
  });

  test('accepts JSON with apiKey or FIRECRAWL_API_KEY', () => {
    assert.equal(parseSecretString('{"apiKey":"fc-json"}'), 'fc-json');
    assert.equal(parseSecretString('{"FIRECRAWL_API_KEY":"fc-json2"}'), 'fc-json2');
  });

  test('rejects empty values and JSON without a key field', () => {
    assert.throws(() => parseSecretString(''), /empty/);
    assert.throws(() => parseSecretString(undefined), /empty/);
    assert.throws(() => parseSecretString('{"other":"x"}'), /apiKey/);
    assert.throws(() => parseSecretString('{not json'), /could not be parsed/);
  });
});
