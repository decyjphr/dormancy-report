# Dormancy Report

Generate an organization-level dormancy report for GitHub users using a 30-day (configurable) activity window.

## What it checks

- Commit activity
- Pull request activity
- Issue activity
- Copilot activity (`last_activity_at`)
- Enterprise login activity (`action:user.login`) when enabled

The script combines audit-log signals with targeted repository verification for candidate dormant users.

## Project structure

- `src/dormancy-report.ts`: CLI implementation
- `docs/prd.md`: product/design notes
- `.env.example`: sample environment variables
- `test/dormancy-report.test.ts`: unit tests

## Prerequisites

- Node.js 20+ recommended (Node 22+ preferred)
- npm
- GitHub token with org/repo read access and required Copilot visibility
  - Personal access token (PAT): set `GITHUB_TOKEN`
  - GitHub App token: set `GITHUB_APP_TOKEN` or use `--github-app-token`
  - App tokens get 5,000 requests/hour; PATs get 60 requests/hour (if unauthenticated), or higher if authenticated

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your env file:

```bash
cp .env.example .env
```

3. Set `GITHUB_TOKEN` in `.env`.

## Run

Example:

```bash
npm run start -- --org your-org
```

Enterprise-wide mode (all enterprise orgs, enterprise members via GraphQL):

```bash
npm run start -- --enterprise your-enterprise
```

Useful options:

- `--days <n>`: dormancy window (default `30`)
- `--mode <authored-only|any-interaction>`
- `--output-dir <dir>`
- `--exclude <comma,separated,logins>`
- `--max-candidates <n>`
- `--concurrency <n>`
- `--github-app-token <token>`: GitHub App token (alternative to GITHUB_TOKEN)
- `--include-login-activity` (enterprise audit-log login signal)
- `--enterprise <enterprise>` (required when `--include-login-activity` is set)

Rate limiting and retries:

- Automatically detects rate limit state from GitHub API
- Pauses requests if approaching limit (10% remaining)
- Waits for reset before resuming
- Retries failed requests up to 5 times with exponential backoff

Behavior notes:

- If `--enterprise` is set, `--org` is optional.
- If `--enterprise` is set without `--org`, the script queries enterprise GraphQL for:
	- all organizations (`enterprise.organizations`)
	- all members (`enterprise.members`)
- It then aggregates dormancy signals across all enterprise org repositories and audit logs.

Example with enterprise login activity:

```bash
npm run start -- --org your-org --include-login-activity --enterprise your-enterprise
```

CLI help:

```bash
npm run start -- --help
```

## Test

Run tests once:

```bash
npm test
```

Watch mode:

```bash
npm run test:watch
```

## Output

By default, reports are written to:

- `tmp/dormancy-report/<org>-dormancy-<days>d.json`
- `tmp/dormancy-report/<org>-dormancy-<days>d.csv`
