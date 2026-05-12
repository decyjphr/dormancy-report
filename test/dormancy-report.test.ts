import { describe, expect, it, vi } from 'vitest'

import {
  csvCell,
  decodePrivateKey,
  detectTokenType,
  isEmptyRepositoryError,
  isEnterpriseLoginAction,
  isCommitAction,
  isIssueAction,
  isPullRequestAction,
  resolveInstallationId,
  toCsv,
} from '../src/dormancy-report'

describe('activity classification', () => {
  it('detects commit actions from audit log values', () => {
    expect(isCommitAction('git.push')).toBe(true)
    expect(isCommitAction('repo.push')).toBe(true)
    expect(isCommitAction('members.added')).toBe(false)
  })

  it('applies pull request mode-specific rules', () => {
    expect(isPullRequestAction('pull_request.opened', 'authored-only')).toBe(true)
    expect(isPullRequestAction('pull_request_review.submitted', 'authored-only')).toBe(false)
    expect(isPullRequestAction('pull_request_review.submitted', 'any-interaction')).toBe(true)
  })

  it('applies issue mode-specific rules', () => {
    expect(isIssueAction('issues.opened', 'authored-only')).toBe(true)
    expect(isIssueAction('issue_comment.created', 'authored-only')).toBe(false)
    expect(isIssueAction('issue_comment.created', 'any-interaction')).toBe(true)
  })
})

describe('csv serialization', () => {
  it('escapes values with commas and quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('a"b')).toBe('"a""b"')
    expect(csvCell('plain')).toBe('plain')
  })

  it('serializes report rows with expected header and values', () => {
    const csv = toCsv([
      {
        login: 'octocat',
        dormant: true,
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
        evidenceSources: ['audit-log'],
        dormancyReason: 'No activity',
      },
    ])

    expect(csv).toContain('login,dormant,commit_active,pr_active,issue_active,copilot_active,login_active')
    expect(csv).toContain('octocat,true,false,false,false,false,false,,0,0,0,0,audit-log,No activity')
  })
})

describe('empty repository handling', () => {
  it('treats 409 empty repository response as a benign case', () => {
    const error = {
      status: 409,
      message: 'Conflict',
      response: {
        data: {
          message: 'Git Repository is empty.',
          documentation_url: 'https://docs.github.com/rest/commits/commits#list-commits',
          status: '409',
        },
      },
    }

    expect(isEmptyRepositoryError(error)).toBe(true)
  })

  it('does not treat unrelated errors as empty repository', () => {
    const error = {
      status: 404,
      message: 'Not Found',
      response: {
        data: {
          message: 'Not Found',
        },
      },
    }

    expect(isEmptyRepositoryError(error)).toBe(false)
  })
})

describe('enterprise login activity', () => {
  it('detects user login audit action', () => {
    expect(isEnterpriseLoginAction('user.login')).toBe(true)
    expect(isEnterpriseLoginAction('business.sso_response')).toBe(false)
  })
})

describe('detectTokenType', () => {
  it('identifies ghu_ prefix as an app token (GitHub App user-to-server)', () => {
    expect(detectTokenType('ghu_abc123XYZ')).toBe('app')
  })

  it('identifies ghs_ prefix as an app token (GitHub App server-to-server)', () => {
    expect(detectTokenType('ghs_abc123XYZ')).toBe('app')
  })

  it('identifies ghp_ prefix as a PAT', () => {
    expect(detectTokenType('ghp_abc123XYZ')).toBe('pat')
  })

  it('identifies fine-grained PAT prefix as a PAT', () => {
    expect(detectTokenType('github_pat_abc123XYZ')).toBe('pat')
  })

  it('treats unknown prefixes as PAT', () => {
    expect(detectTokenType('some_other_token')).toBe('pat')
  })
})

describe('resolveInstallationId', () => {
  function makeOctokit({
    enterpriseResult,
    orgResult,
  }: {
    enterpriseResult?: { id: number } | Error
    orgResult?: { id: number } | Error
  }) {
    return {
      rest: {
        apps: {
          getEnterpriseInstallation: enterpriseResult instanceof Error
            ? vi.fn().mockRejectedValue(enterpriseResult)
            : vi.fn().mockResolvedValue({ data: enterpriseResult }),
          getOrgInstallation: orgResult instanceof Error
            ? vi.fn().mockRejectedValue(orgResult)
            : vi.fn().mockResolvedValue({ data: orgResult }),
        },
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  }

  it('returns enterprise installation ID when enterprise endpoint succeeds', async () => {
    const octokit = makeOctokit({ enterpriseResult: { id: 42 } })
    const id = await resolveInstallationId(octokit, undefined, 'my-enterprise')
    expect(id).toBe(42)
    expect(octokit.rest.apps.getEnterpriseInstallation).toHaveBeenCalledWith({ enterprise: 'my-enterprise' })
  })

  it('falls back to org when enterprise endpoint fails', async () => {
    const octokit = makeOctokit({
      enterpriseResult: new Error('not found'),
      orgResult: { id: 99 },
    })
    const id = await resolveInstallationId(octokit, 'my-org', 'my-enterprise')
    expect(id).toBe(99)
    expect(octokit.rest.apps.getOrgInstallation).toHaveBeenCalledWith({ org: 'my-org' })
  })

  it('returns org installation ID when only org is provided', async () => {
    const octokit = makeOctokit({ orgResult: { id: 7 } })
    const id = await resolveInstallationId(octokit, 'my-org', undefined)
    expect(id).toBe(7)
    expect(octokit.rest.apps.getOrgInstallation).toHaveBeenCalledWith({ org: 'my-org' })
  })

  it('throws when neither org nor enterprise is provided', async () => {
    const octokit = makeOctokit({})
    await expect(resolveInstallationId(octokit, undefined, undefined)).rejects.toThrow(
      'Cannot resolve GitHub App installation ID',
    )
  })
})

describe('decodePrivateKey', () => {
  const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4\n-----END RSA PRIVATE KEY-----'

  it('returns a plain PEM string unchanged', () => {
    expect(decodePrivateKey(PEM)).toBe(PEM)
  })

  it('normalises escaped newlines in PEM strings from env vars', () => {
    const escaped = PEM.replace(/\n/g, '\\n')
    expect(decodePrivateKey(escaped)).toBe(PEM)
  })

  it('decodes a base64-encoded PEM string', () => {
    const b64 = Buffer.from(PEM).toString('base64')
    expect(decodePrivateKey(b64)).toBe(PEM)
  })

  it('throws on input that is neither PEM nor valid base64 PEM', () => {
    expect(() => decodePrivateKey('not-a-key')).toThrow(
      'does not appear to be a valid PEM string or base64-encoded PEM',
    )
  })
})
