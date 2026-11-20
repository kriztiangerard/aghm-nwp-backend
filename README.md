# Network Planning Calculator: Backend

The backend of the Network Planning Calculator, a tool that generates network recommendations from user-provided requirements. This repository contains the recommendation engine, the Bill of Materials (BOM) and pricing logic, the topology data generation, the hardware catalog and database migrations, the scheduled price updater, and the AWS CDK infrastructure (API Gateway, Lambda, RDS PostgreSQL, EventBridge Scheduler).

The single-page application lives in the separate `nwp-frontend` repository.

## Repository Layout

| Path | Contents |
| --- | --- |
| `bin/`, `lib/` | AWS CDK app and stack definitions |
| `backend/src/` | Lambda source code (CommonJS): engine, pricing, services, config, types |
| `backend/db/catalog/` | Hardware catalog data used for seeding |
| `migrations/` | Database schema migrations |
| `scripts/` | Utility scripts (for example catalog seeding) |
| `backend/tests/`, `test/` | Automated tests |

## Local Development Setup
### Prerequisites
- Git
- Node.js
- npm
- AWS CLI, configured with credentials for the target account (needed for deployment)
- A PostgreSQL database for local work

Verify the installations:

- `git --version`
- `node --version`
- `npm --version`
- `aws --version`

### 1. Clone the Repository
- `git clone <repository-url>`
- `cd <project-folder>`

### 2. Switch to the Development Branch
- `git checkout development`
- `git pull origin development`

### 3. Install Dependencies
- `npm ci`

Use `npm install` only when you are adding or updating a dependency.

### 4. Configure Environment Variables
Create a local `.env` file using the provided example:

- `cp .env.example .env` (PowerShell: `Copy-Item .env.example .env`)

Open `.env` and configure the required environment variables (for example `DATABASE_URL`).

**Important:** Do not commit `.env`. Environment files may contain credentials, API keys, database information, or other sensitive configuration. In deployed environments, Lambda configuration and secrets come from CDK and AWS Secrets Manager, not from `.env`.

### 5. Seed the Hardware Catalog
With the catalog tables available and `DATABASE_URL` configured, run:

- `npm run seed:devices`

The seeder upserts router, switch, and access-point records by SKU, resolves capability descriptions, and reports inserted, updated, and skipped counts. Invalid catalog entries are logged and skipped so the remaining entries can still be processed.

### 6. Run the Application Locally
To see all available `npm` scripts:

- `npm run`

**Note:** The exact development command depends on the scripts configured in `package.json`.

### 7. Run Tests
- `npm test`

Make sure the relevant tests pass before submitting a Pull Request.

## API Contract
This repository owns the contract between the backend and the frontend.

- Request shape: `NetworkConfiguration` (`backend/src/types/network-config.ts`).
- Response shape: `EngineResult` and related types (`backend/src/types/api-types.ts`), mirroring the validators in `contracts.js`.
- `CONTRACT_VERSION` is defined in `contracts.js` and `api-types.ts`.

When the contract changes:

1. Update `contracts.js` and `api-types.ts` together.
2. Bump `CONTRACT_VERSION` in both if the change is incompatible.
3. Merge the backend change first, then open a matching Pull Request in `nwp-frontend` copying the updated type files into `src/types/`.

## Deployment
The backend is deployed with the AWS CDK. The frontend is deployed separately through AWS Amplify from the `nwp-frontend` repository.

### First-time setup
- `npx cdk bootstrap` (once per account and region)

### Deploy
- `npx tsc --noEmit`
- `npx cdk synth`
- `npx cdk diff`
- `npx cdk deploy --all`

The deployed API URL is shown in the stack outputs. Provide it to the frontend as `VITE_API_URL` in the Amplify console.

Review the `cdk diff` output before every deploy, and stop if resources you did not intend to change are shown as replaced.

### Data
Deploying does not seed the database. Run migrations and `npm run seed:devices` as a separate step after the first deploy and after catalog changes. Hardware prices are refreshed by the scheduled price updater, and device lifecycle status is verified manually against vendor bulletins.

## Price Updater: Firecrawl Integration

The Price updater scrapes distributor listing pages through [Firecrawl](https://docs.firecrawl.dev) (v2 REST API). The integration lives in `src/pricing/` (CommonJS):

| File | Purpose |
| --- | --- |
| `firecrawl-client.js` | `scrapeProductPage(url, { schema, prompt?, pageTimeoutMs?, country? })`. Calls `POST /v2/scrape` with Firecrawl's JSON format and returns a typed result. Never throws for request failures. |
| `firecrawl-secret.js` | `getFirecrawlApiKey()`. Reads the key from Secrets Manager (`FIRECRAWL_SECRET_ARN`) once per cold start, or from `FIRECRAWL_API_KEY` locally. |
| `firecrawl-errors.js` | `FIRECRAWL_ERROR_TYPES`, the error types the wrapper can return. NWP-PRICE-004 maps them onto `update_log.status`. |

### Configuration

| Variable | Where | Meaning |
| --- | --- | --- |
| `FIRECRAWL_API_KEY` | `.env` (local only) | Firecrawl API key. Never commit it. |
| `FIRECRAWL_SECRET_ARN` | Lambda environment (set by CDK) | Secrets Manager secret holding the key, as the plain key or as JSON `{ "apiKey": "fc-..." }`. Takes precedence over `FIRECRAWL_API_KEY`. |

### Request defaults

- `formats: [{ type: "json", schema }]`: Firecrawl's LLM extraction, so there is no site-specific parsing code.
- `maxAge: 0`: always fetch a fresh page (Firecrawl otherwise serves cached copies up to two days old).
- `location: { country: "PH" }`: Firecrawl defaults to the US; Philippine stores may show different prices to foreign visitors.
- `timeout: 60000` ms page timeout; the client waits 15 s longer before giving up.

### Error types

| `errorType` | When |
| --- | --- |
| `timeout` | No answer in time, or Firecrawl 408/504 |
| `rate_limited` | Firecrawl 429 (`retryAfterSeconds` from `Retry-After` when present) |
| `blocked` | The store answered 401/403/429/451 (CAPTCHA, anti-bot, login wall), or Firecrawl returned 403 for the site |
| `invalid_url` | Not an absolute http(s) URL, or the store answered 404/410 |
| `http_error` | Any other non-success response |
| `empty_content` | Success, but the extracted JSON is missing or every field is empty |
| `auth_error` | Key missing or unreadable, or Firecrawl 401 |
| `quota_exceeded` | Firecrawl 402 (plan credits used up) |
| `network_error` | Firecrawl unreachable, for example while the fck-nat instance is stopped |

Blocks are never solved or worked around, and the wrapper never retries (the retry policy is in NWP-PRICE-004). Error messages are cut to 500 characters, and the API key is replaced with `[redacted]` if it ever appears in one.

### Manual check

```bash
npm run pricing:smoke -- "<distributor listing page URL>"
```

Prints the result and the number of products extracted; exits 0 on success. Each run spends Firecrawl credits.

### Credits and limits (weekly job)

A JSON-format scrape costs 5 credits per page (1 base + 4 for JSON) at the time of writing; cached results are charged in full. Monthly estimate: `listing pages (including extra pagination pages) × 5 × 4.35 weekly runs`. Fill in the plan's monthly credits and concurrent-request limit from the Firecrawl dashboard; the concurrency sets `FIRECRAWL_CONCURRENCY` (NWP-PRICE-002) and the workflow's Map concurrency (NWP-PRICE-011).

### Tests

Pricing tests use `node:test` and run in CI with `node --test tests/pricing/*.test.js`.

## Git Workflow
Do not commit directly to `main` or `development`. All changes must be made on a separate branch and submitted through a Pull Request targeting `development`.

### Branch Naming Convention
Every branch must follow this format:

- `<type>/[<story-id>-]<short-description>`

The NWP Story ID should identify the specific story or task being worked on.

| Type       | Purpose                   | Example                                   |
| ---------- | ------------------------- | ----------------------------------------- |
| `feature/` | New functionality         | `feature/ENGINE-12-device-recommendation` |
| `fix/`     | Bug fixes                 | `fix/BOM-01-pricing-calculation`          |
| `test/`    | Tests                     | `test/BOM-10-validation`                  |
| `docs/`    | Documentation             | `docs/OTHER-26-update-readme`             |
| `chore/`   | Maintenance/configuration | `chore/INFRA-04-update-dependencies`      |

### Branch Naming Rules
- Always include the applicable NWP Story ID (see the Notion board for the appropriate prefix). Remove the NWP prefix.
- If there is no associated story for the branch, do not make your own. Just write the short description instead.
- Use lowercase for the description.
- Use hyphens (-) to separate words.
- Keep the description short and descriptive.
- Do not use spaces.

## Pull Request (PR) Process
All completed work must go through a Pull Request before being merged.

### 1. Start from development
- `git checkout development`
- `git pull origin development`

### 2. Create a Branch
- `git checkout -b feature/XXX-short-description`

### 3. Make and Test Your Changes
Complete the assigned task and test the changes locally.
- `npm test`
- `npx tsc --noEmit`
- `npx cdk synth` (for infrastructure changes)

### 4. Commit Your Changes
Use a clear and descriptive commit message.
- `git add .`
- `git commit -m "Describe your changes"`

### 5. Push Your Branch
- `git push origin feature/XXX-short-description`

### 6. Open a PR
- Target the development branch.
- Reference the appropriate NWP Story ID.
- Clearly describe the changes made.
- Explain how the changes address the assigned story/task.

#### PR Title Format:

`[NWP-TYPE-Story-ID]` Short description of changes

##### Example:

`[NWP-ENGINE-123]` Add device recommendation logic

### 7. Request Review
- The PR requires approval from the assigned member for QA and testing.

### 8. Wait for Approval
- Do not merge the PR yourself.
- Wait for the required reviewers to review and approve the PR.