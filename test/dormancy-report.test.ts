import { describe, expect, it } from 'vitest'

import {
  csvCell,
  isEmptyRepositoryError,
  isEnterpriseLoginAction,
  isCommitAction,
  isIssueAction,
  isPullRequestAction,
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
