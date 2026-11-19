'use strict';

const { createApiKeyProvider, parseSecretString } = require('../../src/pricing/firecrawl-secret');

// Stand-in for @aws-sdk/client-secrets-manager so tests never call AWS.
function fakeSecretsManager(secretString, { failTimes = 0 } = {}) {
  const send = jest.fn();
  let calls = 0;
  send.mockImplementation(async (command) => {
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

    await expect(getApiKey()).resolves.toBe('fc-local');
  });

  test('prefers the Secrets Manager secret when FIRECRAWL_SECRET_ARN is set', async () => {
    const sm = fakeSecretsManager('fc-from-secret');
    const getApiKey = createApiKeyProvider({
      env: { FIRECRAWL_SECRET_ARN: 'arn:aws:secretsmanager:ap-southeast-1:000000000000:secret:firecrawl', FIRECRAWL_API_KEY: 'fc-local' },
      loadSecretsManager: () => sm.module,
    });

    await expect(getApiKey()).resolves.toBe('fc-from-secret');
    expect(sm.send).toHaveBeenCalledTimes(1);
    expect(sm.send.mock.calls[0][0].input).toEqual({ SecretId: 'arn:aws:secretsmanager:ap-southeast-1:000000000000:secret:firecrawl' });
  });

  test('reads the secret once and caches it', async () => {
    const sm = fakeSecretsManager('fc-from-secret');
    const getApiKey = createApiKeyProvider({ env: { FIRECRAWL_SECRET_ARN: 'arn:x' }, loadSecretsManager: () => sm.module });

    await getApiKey();
    await getApiKey();

    expect(sm.send).toHaveBeenCalledTimes(1);
  });

  test('does not cache a failed load', async () => {
    const sm = fakeSecretsManager('fc-from-secret', { failTimes: 1 });
    const getApiKey = createApiKeyProvider({ env: { FIRECRAWL_SECRET_ARN: 'arn:x' }, loadSecretsManager: () => sm.module });

    await expect(getApiKey()).rejects.toThrow(/AccessDenied/);
    await expect(getApiKey()).resolves.toBe('fc-from-secret');
    expect(sm.send).toHaveBeenCalledTimes(2);
  });

  test('fails clearly when nothing is configured', async () => {
    const getApiKey = createApiKeyProvider({ env: {} });

    await expect(getApiKey()).rejects.toThrow(/FIRECRAWL_SECRET_ARN nor FIRECRAWL_API_KEY/);
  });

  test('does not load the AWS SDK when only the local key is set', async () => {
    const loadSecretsManager = jest.fn();
    const getApiKey = createApiKeyProvider({ env: { FIRECRAWL_API_KEY: 'fc-local' }, loadSecretsManager });

    await getApiKey();

    expect(loadSecretsManager).toHaveBeenCalledTimes(0);
  });
});

describe('parseSecretString', () => {
  test('accepts a plain key', () => {
    expect(parseSecretString(' fc-plain ')).toBe('fc-plain');
  });

  test('accepts JSON with apiKey or FIRECRAWL_API_KEY', () => {
    expect(parseSecretString('{"apiKey":"fc-json"}')).toBe('fc-json');
    expect(parseSecretString('{"FIRECRAWL_API_KEY":"fc-json2"}')).toBe('fc-json2');
  });

  test('rejects empty values and JSON without a key field', () => {
    expect(() => parseSecretString('')).toThrow(/empty/);
    expect(() => parseSecretString(undefined)).toThrow(/empty/);
    expect(() => parseSecretString('{"other":"x"}')).toThrow(/apiKey/);
    expect(() => parseSecretString('{not json')).toThrow(/could not be parsed/);
  });
});
