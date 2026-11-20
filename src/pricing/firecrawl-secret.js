'use strict';

// NWP-PRICE-007: loads the Firecrawl API key.
//
// Deployed: FIRECRAWL_SECRET_ARN points to a Secrets Manager secret. The value may be the plain key
// or a JSON object with an "apiKey" (or "FIRECRAWL_API_KEY") field. The key is read once per Lambda
// cold start and cached.
// Local: FIRECRAWL_API_KEY in .env (never committed).
//
// The AWS SDK v3 client is required lazily, only when FIRECRAWL_SECRET_ARN is set, so local runs with
// FIRECRAWL_API_KEY never load it. (NodejsFunction bundles it for the Lambda.)
//
// The Lambda runs in subnets with no direct internet route: Secrets Manager is reachable only through the
// fck-nat instance while it runs, or a Secrets Manager VPC endpoint if the VPC has one. Without either, an
// SDK call would wait until the Lambda timeout, so the client uses short timeouts and a failure names the
// likely cause (NWP-PRICE-010).

const CONNECTION_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 5000;

function hintFor(err) {
  const text = `${err && err.name ? err.name : ''} ${err && err.message ? err.message : ''}`;
  if (/ResourceNotFound/.test(text)) {
    return 'Create it once with: aws secretsmanager create-secret --name aghm-nwp/firecrawl --secret-string file://firecrawl-key.txt';
  }
  if (/AccessDenied/.test(text)) {
    return 'Check that the stack grants this function read access to the secret.';
  }
  return 'If this is a timeout, Secrets Manager is unreachable: start the fck-nat instance, or add a Secrets Manager VPC endpoint.';
}

function defaultLoadSecretsManager() {
  // eslint-disable-next-line global-require
  return require('@aws-sdk/client-secrets-manager');
}

function parseSecretString(secretString) {
  if (typeof secretString !== 'string' || secretString.trim().length === 0) {
    throw new Error('Firecrawl secret is empty.');
  }

  const trimmed = secretString.trim();
  if (!trimmed.startsWith('{')) {
    return trimmed;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error('Firecrawl secret looks like JSON but could not be parsed.');
  }

  const key = parsed && (parsed.apiKey || parsed.FIRECRAWL_API_KEY);
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new Error('Firecrawl secret JSON has no "apiKey" or "FIRECRAWL_API_KEY" field.');
  }
  return key.trim();
}

function createApiKeyProvider({ env = process.env, loadSecretsManager = defaultLoadSecretsManager } = {}) {
  let cached = null;

  async function resolveKey() {
    const secretArn = env.FIRECRAWL_SECRET_ARN;
    if (typeof secretArn === 'string' && secretArn.trim().length > 0) {
      const { SecretsManagerClient, GetSecretValueCommand } = loadSecretsManager();
      const client = new SecretsManagerClient({
        requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
        maxAttempts: 2,
      });
      let output;
      try {
        output = await client.send(new GetSecretValueCommand({ SecretId: secretArn.trim() }));
      } catch (err) {
        const reason = [err && err.name, err && err.message].filter(Boolean).join(': ') || 'unknown error';
        const wrapped = new Error(`Could not read the Firecrawl API key secret (${reason}). ${hintFor(err)}`);
        wrapped.name = 'SecretUnavailableError';
        wrapped.cause = err;
        throw wrapped;
      }
      return parseSecretString(output && output.SecretString);
    }

    const localKey = env.FIRECRAWL_API_KEY;
    if (typeof localKey === 'string' && localKey.trim().length > 0) {
      return localKey.trim();
    }

    throw new Error('Neither FIRECRAWL_SECRET_ARN nor FIRECRAWL_API_KEY is set.');
  }

  return async function getApiKey() {
    if (!cached) {
      // A failed load is not cached, so the next call tries again.
      cached = resolveKey().catch((err) => {
        cached = null;
        throw err;
      });
    }
    return cached;
  };
}

const getFirecrawlApiKey = createApiKeyProvider();

module.exports = {
  getFirecrawlApiKey,
  createApiKeyProvider,
  parseSecretString,
  CONNECTION_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
};
