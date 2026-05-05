import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Command, Option } from 'commander'
import dotenv from 'dotenv'
import { createAppAuth } from '@octokit/auth-app'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'
import { RequestError } from '@octokit/request-error'
import { Octokit } from '@octokit/rest'

dotenv.config({ quiet: true })

const RetryingOctokit = Octokit.plugin(retry, throttling)

export type ActivityMode = 'authored-only' | 'any-interaction'

export type TokenType = 'pat' | 'app'

type AppCredentials = {
  appId: number
  privateKey: string
  installationId?: number
}

type CliOptions = {
  org?: string
  days: number
  mode: ActivityMode
  outputDir: string
  exclude: string
  maxCandidates?: number
  concurrency: number
  enterprise?: string
  includeLoginActivity: boolean
  // GitHub App auth
  appId?: string
  appPrivateKey?: string
  appInstallationId?: string
  // Legacy pre-generated token
  githubAppToken?: string
}

type UserActivity = {
  login: string
  commitActive: boolean
  prActive: boolean
  issueActive: boolean
  copilotActive: boolean
  loginActive: boolean
  copilotLastActivityAt: string | null
  commitEvidenceCount: number
  prEvidenceCount: number
  issueEvidenceCount: number
  loginEvidenceCount: number
  evidenceSources: string[]
  dormant: boolean
  dormancyReason: string
}

type AuditEvent = {
  action?: string
  actor?: string
  '@timestamp'?: string
  created_at?: string
}

type CopilotSeat = {
  assignee?: {
    login?: string
  }
  last_activity_at?: string | null
}

type RepoRef = {
  owner: string
  name: string
}

type RunScope = {
  orgs: string[]
  members: string[]
  scopeLabel: string
}

export function createCliProgram() {
  return new Command()
    .description('Generate an org dormancy report for commits, PRs, issues, and Copilot activity.')
    .option('--org <org>', 'Organization login')
    .option('--github-app-token <token>', 'GitHub App token (instead of GITHUB_TOKEN)')
    .addOption(
      new Option('--days <days>', 'Dormancy window in days').default('30').argParser((value) => {
        const parsed = Number.parseInt(value, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error('--days must be a positive integer')
        }
        return parsed
      }),
    )
    .addOption(
      new Option(
        '--mode <mode>',
        'Activity detection mode (authored-only is strictest and lowest API volume).',
      )
        .choices(['authored-only', 'any-interaction'])
        .default('authored-only'),
    )
    .option('--output-dir <dir>', 'Directory for output files', 'tmp/dormancy-report')
    .option(
      '--exclude <logins>',
      'Comma-separated logins to exclude (for bots/service accounts)',
      '',
    )
    .option('--max-candidates <n>', 'Limit number of candidates verified against repos', (value) => {
      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--max-candidates must be a positive integer')
      }
      return parsed
    })
    .option('--concurrency <n>', 'Parallelism for candidate verification', (value) => {
      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--concurrency must be a positive integer')
      }
      return parsed
    }, 8)
    .option('--enterprise <enterprise>', 'Enterprise slug for enterprise audit log lookups')
    .option(
      '--include-login-activity',
      'Consider enterprise login events (action:user.login) as activity. Requires --enterprise.',
      false,
    )
    .option('--app-id <id>', 'GitHub App ID (use with --app-private-key)')
    .option('--app-private-key <key>', 'GitHub App private key PEM string or path to PEM file')
    .option('--app-installation-id <id>', 'GitHub App installation ID (auto-detected if omitted)')
}

export async function runDormancyReport(options: CliOptions) {
  const cutoffDate = new Date()
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - options.days)
  const cutoffIso = cutoffDate.toISOString()
  const enterprise = options.enterprise ?? process.env.GITHUB_ENTERPRISE

  if (!options.org && !enterprise) {
    throw new Error('Provide --org, --enterprise, or GITHUB_ENTERPRISE')
  }

  const appCreds = resolveAppCredentials(options)
  const tokenType: TokenType = appCreds ? 'app' : 'pat'
  const octokit = await createOctokit(appCreds, options, enterprise)

  const excluded = new Set(
    options.exclude
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => value.toLowerCase()),
  )

  const runScope = await resolveRunScope(octokit, options.org, enterprise)

  console.log(`Scope: ${runScope.scopeLabel}`)
  console.log(`Window: last ${options.days} days (cutoff: ${cutoffIso})`)
  console.log(`Mode: ${options.mode}`)
  console.log(`Auth: ${tokenType}`)

  const members = runScope.members.filter(
    (login) => !excluded.has(login.toLowerCase()),
  )
  console.log(`Members considered: ${members.length}`)

  const repos = await getReposForOrgs(octokit, runScope.orgs)
  console.log(`Repositories discovered: ${repos.length}`)

  const activities = new Map<string, UserActivity>()
  for (const login of members) {
    activities.set(login, {
      login,
      commitActive: false,
      prActive: false,
      issueActive: false,
      copilotActive: false,
      loginActive: false,
      copilotLastActivityAt: null,
      commitEvidenceCount: 0,
      prEvidenceCount: 0,
      issueEvidenceCount: 0,
      loginEvidenceCount: 0,
      evidenceSources: [],
      dormant: false,
      dormancyReason: '',
    })
  }

  await hydrateCopilotActivityForOrgs(octokit, runScope.orgs, cutoffDate, activities)
  await hydrateAuditLogActivityForOrgs(octokit, runScope.orgs, cutoffIso, activities, options.mode)
  await hydrateEnterpriseLoginActivity(
    octokit,
    enterprise,
    cutoffIso,
    activities,
    options.includeLoginActivity,
  )

  let candidates = Array.from(activities.values()).filter(
    (entry) =>
      !entry.commitActive &&
      !entry.prActive &&
      !entry.issueActive &&
      !entry.copilotActive &&
      !entry.loginActive,
  )

  if (options.maxCandidates && candidates.length > options.maxCandidates) {
    candidates = candidates.slice(0, options.maxCandidates)
    console.warn(
      `Candidate verification capped to ${options.maxCandidates}. Use --max-candidates to tune.`,
    )
  }

  console.log(`Candidates for repo verification: ${candidates.length}`)
  await verifyCandidateActivity(octokit, repos, candidates, cutoffDate, options)

  for (const entry of activities.values()) {
    const baseDormant = !entry.commitActive && !entry.prActive && !entry.issueActive && !entry.copilotActive
    entry.dormant = options.includeLoginActivity ? baseDormant && !entry.loginActive : baseDormant
    entry.dormancyReason = entry.dormant
      ? buildDormancyReason(options.days, options.includeLoginActivity)
      : 'Active in at least one signal'
  }

  const all = Array.from(activities.values()).sort((a, b) => a.login.localeCompare(b.login))
  const dormant = all.filter((entry) => entry.dormant)

  await fs.mkdir(options.outputDir, { recursive: true })
  const jsonPath = path.join(options.outputDir, `${runScope.scopeLabel}-dormancy-${options.days}d.json`)
  const csvPath = path.join(options.outputDir, `${runScope.scopeLabel}-dormancy-${options.days}d.csv`)

  const payload = {
    generatedAt: new Date().toISOString(),
    org: options.org ?? null,
    orgs: runScope.orgs,
    days: options.days,
    cutoffIso,
    mode: options.mode,
    includeLoginActivity: options.includeLoginActivity,
    enterprise: enterprise ?? null,
    totals: {
      membersConsidered: all.length,
      dormantUsers: dormant.length,
      activeUsers: all.length - dormant.length,
    },
    users: all,
  }

  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`)
  await fs.writeFile(csvPath, toCsv(all))

  console.log(`Dormant users: ${dormant.length}/${all.length}`)
  console.log(`JSON report: ${jsonPath}`)
  console.log(`CSV report:  ${csvPath}`)
}

function resolveAppCredentials(options: CliOptions): AppCredentials | null {
  const appId = options.appId ?? process.env.GITHUB_APP_ID
  const rawKey = options.appPrivateKey ?? process.env.GITHUB_APP_PRIVATE_KEY
  const installationIdStr = options.appInstallationId ?? process.env.GITHUB_APP_INSTALLATION_ID

  if (!appId && !rawKey) return null

  if (!appId || !rawKey) {
    throw new Error('Both --app-id (GITHUB_APP_ID) and --app-private-key (GITHUB_APP_PRIVATE_KEY) are required for GitHub App auth')
  }

  const parsedId = Number.parseInt(appId, 10)
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    throw new Error('--app-id must be a positive integer')
  }

  const privateKey = decodePrivateKey(rawKey)

  return {
    appId: parsedId,
    privateKey,
    installationId: installationIdStr ? Number.parseInt(installationIdStr, 10) : undefined,
  }
}

export function decodePrivateKey(raw: string): string {
  // Already a PEM string (starts with dashes after optional whitespace)
  const trimmed = raw.trim()
  if (trimmed.startsWith('-----')) {
    // Still normalise escaped newlines that come from env vars like "...KEY...\nstuff"
    return trimmed.replace(/\\n/g, '\n')
  }

  // Try base64 decode — covers both standard and URL-safe base64
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
    if (decoded.trim().startsWith('-----')) {
      return decoded
    }
  } catch {
    // fall through to error
  }

  throw new Error(
    'GITHUB_APP_PRIVATE_KEY does not appear to be a valid PEM string or base64-encoded PEM',
  )
}

function makeThrottleOptions() {
  return {
    onRateLimit(retryAfter: number, options: Record<string, unknown>, _octokit: unknown, retryCount: number) {
      const method = options.method as string | undefined
      const url = options.url as string | undefined
      console.warn(
        `Rate limit hit for ${method} ${url}. Retry after ${retryAfter}s (attempt ${retryCount + 1}).`,
      )
      // Retry up to 2 times before giving up
      return retryCount < 2
    },
    onSecondaryRateLimit(retryAfter: number, options: Record<string, unknown>, _octokit: unknown, retryCount: number) {
      const method = options.method as string | undefined
      const url = options.url as string | undefined
      console.warn(
        `Secondary rate limit hit for ${method} ${url}. Retry after ${retryAfter}s (attempt ${retryCount + 1}).`,
      )
      // Always retry secondary rate limits — they resolve quickly
      return retryCount < 3
    },
  }
}

async function createOctokit(
  appCreds: AppCredentials | null,
  options: CliOptions,
  enterprise: string | undefined,
): Promise<InstanceType<typeof RetryingOctokit>> {
  const throttle = makeThrottleOptions()

  if (!appCreds) {
    const token = process.env.GITHUB_TOKEN ?? options.githubAppToken
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable not set')
    }
    return new RetryingOctokit({
      auth: `token ${token}`,
      retry: { enabled: true, retries: 5 },
      throttle,
    })
  }

  // Step 1: JWT-authenticated Octokit to look up the installation ID
  const appOctokit = new RetryingOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: appCreds.appId,
      privateKey: appCreds.privateKey,
    },
    retry: { enabled: true, retries: 5 },
    throttle,
  })

  const installationId = appCreds.installationId ?? await resolveInstallationId(appOctokit, options.org, enterprise)

  // Step 2: installation-scoped Octokit with auto-refreshing token
  return new RetryingOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: appCreds.appId,
      privateKey: appCreds.privateKey,
      installationId,
    },
    retry: { enabled: true, retries: 5 },
    throttle,
  })
}

export async function resolveInstallationId(
  appOctokit: InstanceType<typeof RetryingOctokit>,
  org: string | undefined,
  enterprise: string | undefined,
): Promise<number> {
  // Try enterprise-level installation first
  if (enterprise) {
    try {
      const { data } = await appOctokit.rest.apps.getEnterpriseInstallation({ enterprise })
      console.log(`GitHub App installation resolved for enterprise ${enterprise}: installation ${data.id}`)
      return data.id
    } catch {
      // Fall through to org-level if enterprise endpoint is unavailable
    }
  }

  if (org) {
    const { data } = await appOctokit.rest.apps.getOrgInstallation({ org })
    console.log(`GitHub App installation resolved for org ${org}: installation ${data.id}`)
    return data.id
  }

  throw new Error(
    'Cannot resolve GitHub App installation ID: provide --app-installation-id, --org, or --enterprise',
  )
}

export function detectTokenType(token: string): TokenType {
  if (token.startsWith('ghu_') || token.startsWith('ghs_')) {
    return 'app'
  }
  return 'pat'
}

async function getOrgMembers(octokit: InstanceType<typeof RetryingOctokit>, org: string) {
  const members = await octokit.paginate(octokit.rest.orgs.listMembers, {
    org,
    per_page: 100,
  })
  return members.map((member) => member.login)
}

async function getOrgRepos(octokit: InstanceType<typeof RetryingOctokit>, org: string) {
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    type: 'all',
    sort: 'updated',
    per_page: 100,
  })
  return repos.map((repo) => ({ owner: org, name: repo.name }))
}

async function resolveRunScope(
  octokit: InstanceType<typeof RetryingOctokit>,
  org: string | undefined,
  enterprise: string | undefined,
): Promise<RunScope> {
  if (enterprise) {
    const orgs = org ? [org] : await getEnterpriseOrganizations(octokit, enterprise)
    const members = await getEnterpriseMembers(octokit, enterprise)
    const scopeLabel = org ? `${enterprise}-${org}` : `enterprise-${enterprise}`
    return { orgs, members, scopeLabel }
  }

  if (!org) {
    throw new Error('Provide --org when enterprise is not set')
  }

  return {
    orgs: [org],
    members: await getOrgMembers(octokit, org),
    scopeLabel: org,
  }
}

async function getReposForOrgs(
  octokit: InstanceType<typeof RetryingOctokit>,
  orgs: string[],
) {
  const reposByOrg = await Promise.all(orgs.map((org) => getOrgRepos(octokit, org)))
  return reposByOrg.flat()
}

async function getEnterpriseOrganizations(
  octokit: InstanceType<typeof RetryingOctokit>,
  enterprise: string,
) {
  const orgs: string[] = []
  let cursor: string | null = null

  while (true) {
    const response = await octokit.graphql<{
      enterprise: {
        organizations: {
          nodes: Array<{ login: string } | null>
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      } | null
    }>(
      `
      query EnterpriseOrganizations($enterprise: String!, $after: String) {
        enterprise(slug: $enterprise) {
          organizations(first: 100, after: $after) {
            nodes {
              login
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `,
      {
        enterprise,
        after: cursor,
      },
    )

    const enterpriseNode = response.enterprise
    if (!enterpriseNode) {
      throw new Error(`Enterprise not found or inaccessible: ${enterprise}`)
    }

    for (const org of enterpriseNode.organizations.nodes) {
      if (org?.login) {
        orgs.push(org.login)
      }
    }

    const pageInfo = enterpriseNode.organizations.pageInfo
    if (!pageInfo.hasNextPage) break
    cursor = pageInfo.endCursor
  }

  return orgs
}

async function getEnterpriseMembers(
  octokit: InstanceType<typeof RetryingOctokit>,
  enterprise: string,
) {
  const members: string[] = []
  let cursor: string | null = null

  while (true) {
    const response = await octokit.graphql<{
      enterprise: {
        members: {
          nodes: Array<{ login: string } | null>
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      } | null
    }>(
      `
      query EnterpriseMembers($enterprise: String!, $after: String) {
        enterprise(slug: $enterprise) {
          members(first: 100, after: $after) {
            nodes {
              login
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `,
      {
        enterprise,
        after: cursor,
      },
    )

    const enterpriseNode = response.enterprise
    if (!enterpriseNode) {
      throw new Error(`Enterprise not found or inaccessible: ${enterprise}`)
    }

    for (const member of enterpriseNode.members.nodes) {
      if (member?.login) {
        members.push(member.login)
      }
    }

    const pageInfo = enterpriseNode.members.pageInfo
    if (!pageInfo.hasNextPage) break
    cursor = pageInfo.endCursor
  }

  return members
}

async function hydrateCopilotActivityForOrgs(
  octokit: InstanceType<typeof RetryingOctokit>,
  orgs: string[],
  cutoff: Date,
  activities: Map<string, UserActivity>,
) {
  for (const org of orgs) {
    const seats = await paginateRoute<CopilotSeat>(octokit, 'GET /orgs/{org}/copilot/billing/seats', {
      org,
      per_page: 100,
    })

    for (const seat of seats) {
      const login = seat.assignee?.login
      if (!login) continue
      const entry = activities.get(login)
      if (!entry) continue

      entry.copilotLastActivityAt = mostRecentIso(entry.copilotLastActivityAt, seat.last_activity_at)
      if (seat.last_activity_at && new Date(seat.last_activity_at) >= cutoff) {
        entry.copilotActive = true
        addEvidence(entry, 'copilot-seat-last_activity_at')
      }
    }
  }
}

async function hydrateAuditLogActivityForOrgs(
  octokit: InstanceType<typeof RetryingOctokit>,
  orgs: string[],
  cutoffIso: string,
  activities: Map<string, UserActivity>,
  mode: ActivityMode,
) {
  const phrase = `created:>=${cutoffIso}`
  for (const org of orgs) {
    const events = await paginateRoute<AuditEvent>(octokit, 'GET /orgs/{org}/audit-log', {
      org,
      phrase,
      include: 'all',
      per_page: 100,
    })

    for (const event of events) {
      const login = event.actor
      const action = event.action ?? ''
      if (!login) continue
      const entry = activities.get(login)
      if (!entry) continue

      if (isCommitAction(action)) {
        entry.commitActive = true
        entry.commitEvidenceCount += 1
        addEvidence(entry, 'audit-log')
      }

      if (isPullRequestAction(action, mode)) {
        entry.prActive = true
        entry.prEvidenceCount += 1
        addEvidence(entry, 'audit-log')
      }

      if (isIssueAction(action, mode)) {
        entry.issueActive = true
        entry.issueEvidenceCount += 1
        addEvidence(entry, 'audit-log')
      }
    }
  }
}

async function hydrateEnterpriseLoginActivity(
  octokit: InstanceType<typeof RetryingOctokit>,
  enterprise: string | undefined,
  cutoffIso: string,
  activities: Map<string, UserActivity>,
  includeLoginActivity: boolean,
) {
  if (!includeLoginActivity) return

  if (!enterprise) {
    console.warn('Skipping enterprise login activity: --enterprise is required when --include-login-activity is set.')
    return
  }

  const phrase = `created:>=${cutoffIso} action:user.login`

  try {
    const events = await paginateRoute<AuditEvent>(
      octokit,
      'GET /enterprises/{enterprise}/audit-log',
      {
        enterprise,
        phrase,
        include: 'all',
        per_page: 100,
      },
    )

    for (const event of events) {
      if (!isEnterpriseLoginAction(event.action ?? '')) continue

      const login = event.actor
      if (!login) continue

      const entry = activities.get(login)
      if (!entry) continue

      entry.loginActive = true
      entry.loginEvidenceCount += 1
      addEvidence(entry, 'enterprise-audit-log-login')
    }
  } catch (error) {
    if (isMissingEnterpriseAuditAccessError(error)) {
      console.warn(
        `Skipping enterprise login activity for enterprise ${enterprise}: missing access or unsupported token permissions.`,
      )
      return
    }
    throw error
  }
}

export function isCommitAction(action: string) {
  const patterns = ['git.push', 'repo.push', 'commit_comment']
  return patterns.some((pattern) => action.includes(pattern))
}

export function isPullRequestAction(action: string, mode: ActivityMode) {
  const authoredPatterns = ['pull_request.opened', 'pull_request.merged', 'pull_request.ready_for_review']
  const interactionPatterns = [
    ...authoredPatterns,
    'pull_request.review_requested',
    'pull_request_review',
    'pull_request_comment',
  ]
  const patterns = mode === 'authored-only' ? authoredPatterns : interactionPatterns
  return patterns.some((pattern) => action.includes(pattern))
}

export function isIssueAction(action: string, mode: ActivityMode) {
  const authoredPatterns = ['issues.opened']
  const interactionPatterns = [
    ...authoredPatterns,
    'issues.closed',
    'issues.reopened',
    'issue_comment',
    'issues.assigned',
    'issues.unassigned',
    'issues.labeled',
    'issues.unlabeled',
  ]
  const patterns = mode === 'authored-only' ? authoredPatterns : interactionPatterns
  return patterns.some((pattern) => action.includes(pattern))
}

export function isEnterpriseLoginAction(action: string) {
  return action === 'user.login'
}

async function verifyCandidateActivity(
  octokit: InstanceType<typeof RetryingOctokit>,
  repos: RepoRef[],
  candidates: UserActivity[],
  cutoffDate: Date,
  options: { concurrency: number; mode: ActivityMode },
) {
  await runWithConcurrency(candidates, options.concurrency, async (entry) => {
    for (const repo of repos) {
      if (!entry.commitActive) {
        const hasCommit = await hasCommitActivity(octokit, repo.owner, repo.name, entry.login, cutoffDate)
        if (hasCommit) {
          entry.commitActive = true
          entry.commitEvidenceCount += 1
          addEvidence(entry, 'repo-commits')
        }
      }

      if (!entry.prActive) {
        const hasPr = await hasPullRequestActivity(
          octokit,
          repo.owner,
          repo.name,
          entry.login,
          cutoffDate,
          options.mode,
        )
        if (hasPr) {
          entry.prActive = true
          entry.prEvidenceCount += 1
          addEvidence(entry, 'repo-pulls')
        }
      }

      if (!entry.issueActive) {
        const hasIssue = await hasIssueActivity(
          octokit,
          repo.owner,
          repo.name,
          entry.login,
          cutoffDate,
          options.mode,
        )
        if (hasIssue) {
          entry.issueActive = true
          entry.issueEvidenceCount += 1
          addEvidence(entry, 'repo-issues')
        }
      }

      if (entry.commitActive && entry.prActive && entry.issueActive) {
        break
      }
    }
  })
}

async function hasCommitActivity(
  octokit: InstanceType<typeof RetryingOctokit>,
  owner: string,
  repo: string,
  login: string,
  cutoffDate: Date,
) {
  try {
    const commits = await withRetry(async () => {
      const response = await octokit.rest.repos.listCommits({
        owner,
        repo,
        author: login,
        since: cutoffDate.toISOString(),
        per_page: 1,
      })
      return response.data
    })
    return commits.length > 0
  } catch (error) {
    if (isEmptyRepositoryError(error)) {
      return false
    }
    throw error
  }
}

export function isEmptyRepositoryError(error: unknown) {
  if (!error || typeof error !== 'object') return false

  const status = getErrorStatus(error)
  if (status !== 409) return false

  const message = getErrorMessage(error)
  return message.toLowerCase().includes('git repository is empty')
}

function isMissingEnterpriseAuditAccessError(error: unknown) {
  if (!(error instanceof RequestError)) return false
  return error.status === 403 || error.status === 404
}

function buildDormancyReason(days: number, includeLoginActivity: boolean) {
  if (includeLoginActivity) {
    return `No commit, PR, issue, Copilot, or login activity in last ${days} days`
  }

  return `No commit, PR, issue, or Copilot activity in last ${days} days`
}

function mostRecentIso(current: string | null, incoming: string | null | undefined) {
  if (!incoming) return current
  if (!current) return incoming
  return new Date(incoming) > new Date(current) ? incoming : current
}

function getErrorStatus(error: Record<string, unknown>) {
  const status = error.status
  if (typeof status === 'number') return status
  if (typeof status === 'string') {
    const parsed = Number.parseInt(status, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function getErrorMessage(error: Record<string, unknown>) {
  const topLevelMessage = typeof error.message === 'string' ? error.message : ''
  const response = error.response
  if (!response || typeof response !== 'object') return topLevelMessage

  const data = (response as { data?: unknown }).data
  if (!data || typeof data !== 'object') return topLevelMessage

  const dataMessage = (data as { message?: unknown }).message
  if (typeof dataMessage !== 'string') return topLevelMessage

  return `${topLevelMessage} ${dataMessage}`.trim()
}

async function hasPullRequestActivity(
  octokit: InstanceType<typeof RetryingOctokit>,
  owner: string,
  repo: string,
  login: string,
  cutoffDate: Date,
  mode: ActivityMode,
) {
  const pulls = await withRetry(async () => {
    const response = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 50,
    })
    return response.data
  })

  for (const pull of pulls) {
    if (new Date(pull.updated_at) < cutoffDate) {
      break
    }

    if (pull.user?.login === login) return true
    if (mode === 'any-interaction') {
      if (pull.assignees.some((user) => user.login === login)) return true
      if (pull.requested_reviewers.some((user) => user.login === login)) return true
    }
  }

  return false
}

async function hasIssueActivity(
  octokit: InstanceType<typeof RetryingOctokit>,
  owner: string,
  repo: string,
  login: string,
  cutoffDate: Date,
  mode: ActivityMode,
) {
  const issues = await withRetry(async () => {
    const response = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: 'all',
      since: cutoffDate.toISOString(),
      per_page: 50,
    })
    return response.data
  })

  for (const issue of issues) {
    if (issue.pull_request) continue
    if (issue.user?.login === login) return true
    if (mode === 'any-interaction' && issue.assignees.some((user) => user.login === login)) {
      return true
    }
  }

  return false
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 5, sleepMs = 2500): Promise<T> {
  let currentError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      currentError = error
      if (!(error instanceof RequestError)) {
        throw error
      }

      const retriableStatus = [403, 429, 500, 502, 503, 504]
      if (!retriableStatus.includes(error.status) || attempt === attempts) {
        throw error
      }

      await sleep(sleepMs * attempt)
    }
  }

  throw currentError
}

async function paginateRoute<T>(
  octokit: InstanceType<typeof RetryingOctokit>,
  route: string,
  parameters: Record<string, unknown>,
) {
  const results: T[] = []
  const iterator = octokit.paginate.iterator(route, parameters)

  for await (const response of iterator) {
    const payload = response.data
    if (Array.isArray(payload)) {
      results.push(...(payload as T[]))
      continue
    }

    if (payload && typeof payload === 'object' && Array.isArray((payload as { seats?: T[] }).seats)) {
      results.push(...((payload as { seats: T[] }).seats || []))
    }
  }

  return results
}

function addEvidence(entry: UserActivity, source: string) {
  if (!entry.evidenceSources.includes(source)) {
    entry.evidenceSources.push(source)
  }
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let cursor = 0

  async function runNext() {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await worker(item)
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runNext())
  await Promise.all(workers)
}

export function toCsv(entries: UserActivity[]) {
  const header = [
    'login',
    'dormant',
    'commit_active',
    'pr_active',
    'issue_active',
    'copilot_active',
    'login_active',
    'copilot_last_activity_at',
    'commit_evidence_count',
    'pr_evidence_count',
    'issue_evidence_count',
    'login_evidence_count',
    'evidence_sources',
    'dormancy_reason',
  ]

  const lines = [header.join(',')]
  for (const entry of entries) {
    lines.push(
      [
        entry.login,
        String(entry.dormant),
        String(entry.commitActive),
        String(entry.prActive),
        String(entry.issueActive),
        String(entry.copilotActive),
        String(entry.loginActive),
        entry.copilotLastActivityAt ?? '',
        String(entry.commitEvidenceCount),
        String(entry.prEvidenceCount),
        String(entry.issueEvidenceCount),
        String(entry.loginEvidenceCount),
        entry.evidenceSources.join('|'),
        entry.dormancyReason,
      ]
        .map(csvCell)
        .join(','),
    )
  }

  return `${lines.join('\n')}\n`
}

export function csvCell(value: string) {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`
  }
  return value
}

async function sleep(ms: number) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isMainModule() {
  const entryPoint = process.argv[1]
  if (!entryPoint) return false
  return import.meta.url === pathToFileURL(entryPoint).href
}

if (isMainModule()) {
  const options = createCliProgram().parse(process.argv).opts<CliOptions>()
  runDormancyReport(options).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
