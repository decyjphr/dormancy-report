**Hybrid Dormancy Design (30-day, Org-Level, No Search API Dependency)**

1. Goal
   Identify organization users who have had zero activity in the last 30 days across:
2. Commit activity
3. Pull request activity
4. Issue activity
5. Copilot activity
6. Why this design
7. Avoids Search API result caps and timeout behavior.
8. Uses audit logs and direct APIs that scale better for large orgs.
9. Separates fast detection from targeted verification for accuracy.
10. Signals and source of truth
11. Commit activity
    Primary: Organization audit log REST API, git category events (actor + created time).
    Verification fallback: Repository commits endpoint per repo with since + author filters for only candidate users.
12. Pull request activity
    Primary: Organization audit log events for pull request actions.
    Verification fallback: Per-repo pull request and review/comment endpoints for candidate users only.
13. Issue activity
    Primary: Organization audit log events for issue actions.
    Verification fallback: Per-repo issues and issue comments endpoints for candidate users only.
14. Copilot activity
    Source: Copilot seat assignments endpoint using last_activity_at.
15. Scope and policy
16. Population
    Start from current organization members.
17. Window
    Rolling last 30 days, UTC.
18. Dormant decision
    Dormant if all four signals are inactive in the window.
19. Optional policy modes
    Authored-only mode: only user-authored commit/PR/issue actions count.
    Any-interaction mode: authored plus comments/reviews/assignment/labeling events count.
20. Processing architecture
21. Stage A: Collect member roster
    List all org members and normalize user identities.
22. Stage B: Fast activity index (high scale)
    Query org audit log for last 30 days and map actor -> activity flags:
23. commit_active
24. pr_active
25. issue_active
26. Stage C: Copilot overlay
    Fetch Copilot seats and set copilot_active using last_activity_at >= cutoff.
27. Stage D: Candidate selection
    Candidates are users with no active flags from B and C.
28. Stage E: Targeted verification (accuracy pass)
    Run per-repo commit/PR/issue checks only for candidates to reduce API volume.
29. Stage F: Final classification
    Dormant if still no activity after verification.
30. Stage G: Output artifacts
    Produce:
31. Dormant users list
32. Per-user evidence fields
33. Reason codes showing which checks were empty
34. Optional CSV and JSON
35. Data model (recommended)
    Per user record:
36. login
37. window_start_utc
38. commit_active
39. pr_active
40. issue_active
41. copilot_active
42. copilot_last_activity_at
43. evidence_commit_count
44. evidence_pr_count
45. evidence_issue_count
46. evidence_sources_used
47. dormant (boolean)
48. dormancy_reason
49. Reliability and limitations handling
50. Copilot last_activity_at can lag up to 24 hours; treat very recent users carefully.
51. Copilot last_activity_at retention is 90 days; inactive users may show nil after that.
52. Audit log coverage should be used with known caveats:
53. REST audit log supports git events.
54. Some git events initiated via web/REST/GraphQL are not represented as git events in that feed.
55. Because of #3, keep targeted repository verification for candidates.
56. Keep a short exclusion list for bots/service accounts.
57. Rate limit and performance strategy
58. Use pagination everywhere.
59. Use bounded concurrency (for example 5 to 20 workers).
60. Cache org repo list for each run.
61. Incremental mode:
62. Persist last successful run timestamp.
63. Pull only new audit events each run.
64. Backoff on 403/429 and resume.
65. Split large org processing by user shard if needed.
66. Security and permissions
67. Read org membership.
68. Read org audit log.
69. Read repository metadata and issue/PR/commit data where needed.
70. Read Copilot seat assignment/activity fields.
71. Store only minimal user metadata in outputs.
72. Runbook
73. Daily run.
74. Produce report and delta since previous run.
75. Optional workflow:
76. Notify inactive users after first detection.
77. Re-check after grace period.
78. Reclaim seat/access per policy.
79. Implementation blueprint (minimal)
80. Input: org, days=30, mode=any-interaction, exclude_list.
81. Build member set.
82. Build activity flags from audit log.
83. Merge Copilot activity.
84. Verify candidates with targeted repo checks.
85. Emit dormant report + evidence report.
86. Store run metadata for next incremental execution.

If you want, I can turn this design into:

1. A concrete endpoint map with exact request/response fields.
2. A production pseudocode flow.
3. An implementation skeleton in Node.js with pagination, retry, and CSV export.

## Design
For large orgs, move away from Search API as the primary source and use one of these patterns.

**Best Alternatives**

1. Org audit log (best for scale, easiest to query centrally)

- Endpoint: `GET /orgs/{org}/audit-log`
- Use actor + action + created_at to infer activity in last 30 days.
- Pros: One stream across org, scalable, good for “any activity” checks.
- Cons: Not every event is equally detailed for contribution semantics; tune action filters carefully.

1. Repo-by-repo API scan (most accurate for commits/PRs/issues)

- List repos: `GET /orgs/{org}/repos`
- Commits: `GET /repos/{owner}/{repo}/commits?author={user}&since={cutoff}`
- PRs: `GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc` then filter by user/review/comment as needed
- Issues: `GET /repos/{owner}/{repo}/issues?state=all&since={cutoff}` then filter by user interactions
- Pros: Deterministic, no Search API 1000-result limitations.
- Cons: Higher API volume; needs good parallelism + caching.

1. User org events (cheap signal, good as pre-filter)

- Endpoint: `GET /users/{username}/events/orgs/{org}`
- Look for `PushEvent`, `PullRequestEvent`, `IssuesEvent`, etc.
- Pros: Fast and lightweight for quick “active/inactive” hinting.
- Cons: Event feed limits (recent window/count), not full historical truth.

1. Webhook or audit-log streaming pipeline (best long-term)

- Stream org/repo events to datastore (or SIEM), then run dormancy queries there.
- Pros: Near-real-time, low repeated API cost, excellent for policy reporting.
- Cons: Requires setup; best for ongoing governance.

1. Copilot activity (keep as dedicated source)

- Endpoint: `GET /orgs/{org}/copilot/billing/seats`
- Use `last_activity_at >= cutoff`.

------

**Recommended hybrid design for your use case**

1. Use audit log as the primary “activity index” for last 30 days.
2. For users with no audit-log hits, run targeted repo-by-repo checks for commits/PRs/issues to confirm.
3. Merge with Copilot `last_activity_at`.
4. Mark dormant only if all four are inactive.

This gives scale plus accuracy, and avoids Search API blind spots.

## Design Validation
Validated against this repository, with source-backed corrections and confirmations.

**What Was Confirmed**

1. Built-in dormancy for enterprise cloud is 30 days with no qualifying activity.
   Sources: [managing-dormant-users.md:30](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html), [dormant-user-activity-threshold.md:1](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html)
2. Built-in dormancy is based on GitHub-defined activity types, not just commits/PRs/issues.
   Source activity list: [dormant-user-activity.md:1](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html)
3. Enterprise dormancy scope is enterprise-associated org/repo/sign-on events.
   Source: [managing-dormant-users.md:27](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html)
4. A built-in dormant users report exists in enterprise account flows.
   Source: [managing-dormant-users.md:74](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html)
5. Copilot activity is a separate data model using last_activity_at.
   Sources: [metrics-data.md:13](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html), [remind-inactive-users.md:25](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html)
6. Search API has hard limits that affect commit-search-based dormancy logic.
   Sources: [search.md:20](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html), [search.md:34](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html), [search.md:85](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html)

**Assumptions That Need Correction**

1. Built-in dormancy is not equivalent to no commits + no PR + no issues.
   It includes many other actions (for example sign-in/authentication, being added to a repo, changing visibility, labels/assignments/review request actions, starring, joining org).
   Source: [dormant-user-activity.md:1](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html)
2. Copilot usage is not listed as a built-in dormancy activity signal.
   Copilot has its own reporting signal and retention rules.
   Sources: [dormant-user-activity.md:1](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html), [metrics-data.md:43](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html)
3. Built-in dormancy also explicitly excludes some activity from counting as active.
   Notably PAT/SSH key/GitHub App access and Git operations on private repositories are not counted as active in that definition.
   Source: [dormant-user-activity.md:29](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html)
4. Dormancy management/reporting in these docs is enterprise-admin oriented, not an organization-level dormant-users feature page.
   Sources: [managing-dormant-users.md:1](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html), [managing-dormant-users.md:11](vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html)

If you want, I can now convert this into a concrete “validated hybrid” design for your org-level operational report:

1. enterprise dormancy status as baseline,
2. org-scoped commits/PR/issues checks via non-search endpoints,
3. Copilot last_activity_at overlay,
4. final 30-day dormant decision policy.