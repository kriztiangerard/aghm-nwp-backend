'use strict';

// NWP-PRICE-010: reads the Firecrawl API key.
//
//   Local runs:  FIRECRAWL_API_KEY in .env (never committed).
//   Lambda:      the Secrets Manager secret named by FIRECRAWL_SECRET_ARN (aghm-nwp/firecrawl), whose value
//                is the key alone. Set in lib/aghm-nwp-stack.ts.
//
// The Lambda runs in subnets with no direct internet route. Secrets Manager is reachable only through a
// VPC interface endpoint, if the VPC has one, or through the fck-nat instance while it is running. Without
// either, an SDK call would wait until the Lambda's 15-minute timeout. The short timeouts below make it fail
// within seconds with SecretUnavailableError instead, which names the likely cause.
//
// The key is cached for the life of the Lambda container and never logged.

const CONNECTION_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 5000;

class SecretUnavailableError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'SecretUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

function defaultClient() {
  const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
  return new SecretsManagerClient({
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
    maxAttempts: 2,
  });
}

/**
 * @param {Object} [options]
 * @param {Record<string, string|undefined>} [options.env]  default: process.env
 * @param {Function} [options.clientFactory]                returns an object with send(command); tests inject one
 * @returns {() => Promise<string>} returns the key; cached after the first successful read
 */
function createFirecrawlKeyLoader({ env = process.env, clientFactory = defaultClient } = {}) {
  let cached = null;

  return async function getFirecrawlApiKey() {
    if (cached) return cached;

    const localKey = typeof env.FIRECRAWL_API_KEY === 'string' ? env.FIRECRAWL_API_KEY.trim() : '';
    if (localKey) {
      cached = localKey;
      return cached;
    }

    const secretId = env.FIRECRAWL_SECRET_ARN;
    if (!secretId) {
      throw new SecretUnavailableError(
        'Firecrawl API key is not configured: set FIRECRAWL_API_KEY (local) or FIRECRAWL_SECRET_ARN (Lambda).',
      );
    }

    const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    let response;
    try {
      response = await clientFactory().send(new GetSecretValueCommand({ SecretId: secretId }));
    } catch (error) {
      const name = error && error.name ? error.name : 'Error';
      const hint = name === 'ResourceNotFoundException'
        ? 'Create it once with: aws secretsmanager create-secret --name aghm-nwp/firecrawl --secret-string file://firecrawl-key.txt'
        : name === 'AccessDeniedException'
          ? 'Check that the stack grants this function read access to the secret.'
          : 'If this is a timeout, Secrets Manager is unreachable: start the fck-nat instance, or add a Secrets Manager VPC endpoint.';
      throw new SecretUnavailableError(`Could not read the Firecrawl API key (${name}). ${hint}`, { cause: error });
    }

    const key = typeof response.SecretString === 'string' ? response.SecretString.trim() : '';
    if (!key) {
      throw new SecretUnavailableError('The Firecrawl API key secret is empty; its value must be the key alone.');
    }
    cached = key;
    return cached;
  };
}

module.exports = {
  createFirecrawlKeyLoader,
  getFirecrawlApiKey: createFirecrawlKeyLoader(),
  SecretUnavailableError,
  CONNECTION_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
};
