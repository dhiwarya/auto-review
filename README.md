# Auto Reviewer

A personal review agent that runs on your own machine. When someone requests your review on GitHub, it reviews the PR with your own Claude Code and Codex logins and leaves a **draft review that only you can see**. You edit it and submit it yourself. A local dashboard shows the queue, live progress and leaderboards.

## What a review covers

The **Standard** profile uses one provider for the review: **Codex** by default (Sol 6.1, then Sol 6), with **Claude** taking over only if Codex runs out (Opus 5.5, then Opus 4.8). You can switch providers, or turn the fallback off, on the dashboard's Settings page. The **Strict** profile requires both providers, as described below.

Security reviews can trip a provider's safety filter (OpenAI may flag one as "possible cybersecurity risk"). That run then goes to the next model in the same order, ending with Claude if the fallback is on. Nothing is paused, since the refusal is about that PR, not the model. The security instructions say plainly that this is a defensive review of the team's own code, and never ask for exploit code or payloads.

| Pass | Looks for |
| --- | --- |
| Code + requirements | Bugs, edge cases, error handling, concurrency, weak tests, breaking changes. It also compares the code with the linked GitHub issues: requirements that are **missing**, implemented **differently** from the issue, or **inconsistent** with the PR description. |
| Security | Injection, auth gaps, secrets, SSRF, path traversal, unsafe deserialization, risky dependency or CI changes, each traced from input to sink. |
| Double-check | Every blocker and major is re-checked in a second, separate run. Refuted findings are dropped, and uncertain ones are downgraded. |

After that, plain code (no model) checks each finding:
- The quoted evidence must really exist in the file.
- The file must exist.
- The comment must sit on a line GitHub accepts. If it doesn't, the finding moves to the summary.
- Duplicates and points already raised in an earlier review are removed.
- Nits are capped.
- Any credential in the output is redacted. If a credential appears that the PR itself didn't add, the finding is dropped as a possible exfiltration attempt.

Severity scale: **blocker**, **major**, **minor**, **nit**.

### Strict reviews

Select **Settings → Reviewer → Review profile → Strict**. Standard remains the default for existing and new installations. Selecting Strict does not change dry run, draft/publish mode, or the repository list. Both Codex and Claude CLI logins are required.

Strict reviews run code/requirements and security passes on the primary provider, then a fresh adversarial pass on the other provider. The independent pass does not see the current review's other findings. Serious findings are verified in fresh runs on the provider opposite the one that raised them. Model fallback stays within the assigned provider; the Standard cross-provider fallback switch does not weaken this requirement.

The reviewer creates a manifest of code and context sections. Strict retrieves complete PR descriptions, linked issues, paginated comments and base-branch guidelines; it does not use Standard's fixed-size excerpts. Complete source snapshots are saved per job, with hashes and exact character ranges for each assigned section. Local copies inside the throwaway checkout remain available for cross-batch lookup. Every required pass must account for each assigned section and report the dependencies, tests and configuration it examined. Claimed file paths must exist inside the checkout. Large changes are split into bounded batches, followed by primary and independent consolidation checking interactions and finishing the requirement checklist. The independent consolidation sees only its own earlier assessments. Real minor findings are still included; the Standard large-PR top-risk restriction does not apply. Strict evidence must match a complete quoted block, allowing indentation differences. Requirement findings can instead quote actual linked-issue evidence.

The job page distinguishes source material included in a prompt, the model's reported examination, and its recorded tool activity. Coverage reports are evidence of the review process, not proof that a model understood the code. Exclusions stay visible. Missing sections, unavailable sources, exhausted budgets, or failed stages make the review incomplete. The app attempts targeted continuations, then retains an unfinished result locally instead of automatically publishing it. Recoverable provider outages wait; exhausted recovery requires action on the dashboard. A failed/cancelled incomplete result can be posted manually only after explicitly selecting the partial-review checkbox; a partial publish is a comment and never approves or requests changes.

Requirement assessments use the parent issue refs from the retrieved manifest. Citations to retrieved issue comments are normalized to their parent before checking completion and reviewer agreement. Unknown issues or nonexistent comment ordinals are rejected. Continuations receive the exact missing/unfinished criteria and valid refs, and retain completed code coverage without asking the model to repeat it. A completed assessment can still block approval when promised behavior is missing or acceptance remains externally unverified.

| Strict budget | Default |
| --- | --- |
| Time per model run | 1,800 seconds |
| Characters per run, including context and an instruction allowance | 500,000 |
| Review batches | 16 |
| Model attempts per job, including continuations, verification and model fallbacks | 64 |
| Continuations per stage | 2 |
| Attempts reserved for verification | 8 (when the planned workload leaves room) |
| Claude turns per run | 120 |
| Claude effort | High |

Successful, schema-valid stages are saved under their exact input fingerprint. After an unavailable provider recovers, only missing stages run again. A stage with missing coverage continues with the unexamined sections and merges the results. The app estimates discovery/consolidation work before running and reserves attempts for later stages and verification. Other stage failures use bounded job retries. Exhausted budgets require a new full review with suitable settings. Repeated calls count against the total job attempt budget, including calls from earlier attempts. Stored settings with the previous default 8 batches/32 attempts are upgraded once to 16/64; other custom values are preserved.

Requirements are assessed as a checklist. An issue the PR closes represents its promised full scope. Merely mentioning an issue does not promise completion of its entire roadmap: deferred or unrelated criteria need source-backed scope evidence, corroboration against the code, and independent reviewer agreement. Missing promised behavior still blocks approval. Operational/manual acceptance that cannot be established from code is recorded as externally unverifiable and blocks approval without making completed code coverage unfinished.

Strict approval always requires high confidence, complete required stages and coverage, no open blocker or major from any review, no unresolved serious verification, no material requirement gaps, and no unresolved review questions. The existing commit, draft-PR, self-approval, manual-change-request and credential checks still apply. The preview and actual post use the same decision. A failed verifier never silently qualifies a Strict review for approval. Uncertain serious concerns retain their severity and appear as clearly marked summary items for human inspection.

Each started job stores its review profile, policy version and effective settings. Retries retain that policy and successful source snapshot. An incomplete source fetch is retried rather than frozen permanently. Unposted jobs from the previous Strict policy are explicitly upgraded, retaining their old policy in the saved record and rebuilding full coverage before posting. More restrictive current approval settings also apply at posting; changing to Standard cannot remove a started Strict job's gates. Draft submission remains your decision. Strict adds no new automatic request-changes behavior to initial reviews.

Incremental reviews require complete current-policy Strict coverage at their baseline. Baseline confidence is separate: a complete earlier review containing a major finding is still a valid coverage baseline, and the open finding is checked independently. Missing, older-policy or incomplete baselines automatically expand the job into one full review of the current PR. Strict rechecks refresh full code/context coverage and the PR discussion while reassessing earlier findings; they do not raise new findings on an unchanged commit. **Full PR review** remains available for a fresh review with current settings and budgets. If you already have a pending GitHub review, submit or discard it before another can be posted.

## Lifecycle

```
review requested ─► queued ─► reviewing ─► posted ─► approved, or feedback
                                  │
       new commits pushed ────────┤ (follow-up review of only the new commits; fixed findings are listed)
       re-requested, no commits ──┤ (re-check of the findings still open; see below)
       request removed/PR closed ─┤ cancelled
       both models at their limit ┤ waiting until the limit resets
       you have a pending review  ┤ waiting until you submit or discard it
       3 failed attempts ─────────┴ failed (shown on the dashboard)
```

### Reviewing again

Submitting a review takes you off the PR's requested reviewers, as on GitHub for anyone. To get another review, the author **re-requests your review**:

- **With new commits:** a follow-up review of only the commits since the last one. It lists the earlier findings the new code fixes, and doesn't raise the ones still open again.
- **Without new commits:** a **re-check**. Nothing new is raised on code that was already reviewed. Each finding still open from earlier reviews is read again against the code and what was said on the PR since (replies in its thread, and the PR conversation), and stays open or is resolved. A reply saying "fixed" or "intentional" only resolves a finding when the code confirms it. The review then:
  - **requests changes** while a blocker or major is still open,
  - **comments** when only minors or nits are,
  - **approves** when everything is resolved and the rules in [Confidence and approval](#confidence-and-approval) allow it.

  In draft mode it prepares the draft and the dashboard says which to choose when you submit it. A draft you haven't submitted, a discarded draft and a dry run leave you on the requested reviewers, so they never trigger a re-check; use **Re-check** on the review's page instead.

A PR carries one of these labels at a time. The names are set in Settings:

| Label | Meaning |
| --- | --- |
| `dh: on review` | Review in progress. In draft mode it stays until you submit the draft. |
| `dh: feedback` | Reviewed without approving. |
| `dh: approved` | Approved for you, or you submitted your draft as an approval. |

Adding labels needs triage access. If the token can't add them, the review still works, and the summary carries a hidden marker instead. Labels from earlier versions (`ai-review:*`) are taken off a PR when it gets a new one.

## Comments

Plain markdown with no emoji and no model details. Inline comments read `**Blocker (bug):** title`, then the problem and a suggestion. The summary opens with the counts (`**1 blocker, 2 minor**`, or `**No issues found.**`), then the overall assessment, requirements, findings not tied to a line, questions and what was fixed since the last review, each only when there is something to say. Every comment is signed `Auto Reviewer`. The model, confidence and double-check details stay on the dashboard.

## Confidence and approval

Every review gets a confidence level: how sure it is that nothing blocks the PR. It starts at high and drops for anything that leaves doubt:

| Lowers it to | When |
| --- | --- |
| Medium | A major finding is open, there are questions for the author, the code only partly matches the linked issue, the change is large, or the diff was too long to send in full |
| Low | The code doesn't match the linked issue, or the PR tried to get a credential out of the reviewer |
| Either | A review pass rates its own confidence lower, saying what it couldn't check |

A published review **approves the PR** when no blocker is open (in this review or an earlier one on the PR) and the confidence is at least the minimum set in Settings (high by default). It never approves a draft (you decide when you submit it), a draft PR, your own PR, a PR with commits newer than the review, or one where you requested changes yourself. A change request the app published from a re-check doesn't count as yours: approving replaces it. Otherwise it posts a comment review, and the dashboard says why it didn't approve. An approval counts toward branch protection, so the PR may become mergeable.

## Safety model

- **Only the repos you list in Settings** are ever reviewed. Keep public repos where strangers open PRs out of that list.
- **Read-only agents.** Claude runs as `claude -p --restricted --tools Read,Grep,Glob`, with no MCP servers and no project settings or hooks loaded from the PR, so it can only read files. Codex runs as `codex exec --sandbox read-only`, with no user config, no rules and no `AGENTS.md`. Codex works through shell commands, so its instructions forbid running, building, installing or testing anything from the repository. Its sandbox also blocks file writes and network access, and any credential that shows up in its output is dropped.
- **The agents never get your GitHub token.** They get an allowlisted environment, and their only output is JSON. The app does all GitHub writes itself.
- **Nothing posted can carry a credential.** Every finding, summary, question and note is checked for secret formats (GitHub, Anthropic, OpenAI, AWS, Slack, private keys, JWTs). A secret the PR doesn't add itself is redacted and lowers the confidence to low. Right before posting, the whole review is also checked against the app's own credentials, word for word: the GitHub token, the Claude token and the Codex and Claude login files. A match stops the post and fails the review.
- **Throwaway checkouts.** Each review gets its own worktree of the PR head in a temp folder, made from the local repo copy, with symlinks disabled. It's deleted afterwards. Your GitHub token is passed to git through the environment and never written into the local copy.
- **Approves only under strict rules, and requests changes only from a re-check.** Draft mode posts a pending review. Publish mode approves when the rules in [Confidence and approval](#confidence-and-approval) allow it, requests changes when a [re-check](#reviewing-again) finds a blocker or major still open, and posts a comment review otherwise. Text in a PR can't raise the confidence: the hard rules are checked by the app, not the model.
- **Local dashboard.** It listens on `127.0.0.1` only, rejects foreign `Host` headers (DNS rebinding), and requires a custom header on every write (CSRF).
- **Subscription terms.** It drives the official `claude` and `codex` CLIs with your own logins, for your own review queue. Don't share one instance with teammates. Each person should run their own.
- **Company code.** These reviews send your repos' code to your personal Claude and ChatGPT accounts. Check that your employer allows it, and turn off model training in both accounts.

## Setup

Requirements: Node 22.18 or newer, `git`, and the [GitHub CLI](https://cli.github.com) (or a token). You also need [Claude Code](https://code.claude.com) and/or the [Codex CLI](https://developers.openai.com/codex). One of the two is enough: the app falls back to whichever is available.

```bash
npm install
npm run build
```

Sign in to each tool:

```bash
gh auth login
```

```bash
claude auth login
```

```bash
codex login
```

A fine-grained GitHub token is optional but recommended. It limits the bot to the repos it reviews (`.env.example` lists the scopes). Without one, the app uses your `gh` login.

```bash
cp .env.example .env
```

Start it:

```bash
npm start
```

Open http://127.0.0.1:4477, go to **Settings**, and list the repos to review. Nothing is reviewed until you do.

It starts in **dry run**: reviews run and appear in the dashboard, but nothing is posted. Once the findings look right, turn dry run off in Settings.

### Start at login

| OS | Command |
| --- | --- |
| macOS | `sh deploy/macos/install.sh` (remove with `sh deploy/macos/install.sh remove`). Logs go to `data/reviewer.log`. |
| Linux | Follow the steps at the top of `deploy/linux/auto-reviewer.service` (systemd user service) |
| Windows | `powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1` (Task Scheduler) |

### Run in Docker

The image has everything the app runs: Node, git, ripgrep, Claude Code and Codex. Docker keeps it running, and starts it again with Docker, until you stop it. Only Docker is needed on the machine.

Sign in once. A container can't use your computer's own logins, so each tool gets its own:

1. GitHub: put a token in `.env`. The quickest is your `gh` login; a fine-grained token (scopes in `.env.example`) is safer.

   ```bash
   echo "GITHUB_TOKEN=$(gh auth token)" >> .env
   ```

2. Claude: run `claude setup-token` on your computer. It opens the browser and prints a long-lived token for your subscription. Add it to `.env` as `CLAUDE_CODE_OAUTH_TOKEN=…`.

3. Codex: sign in inside the container. It shows a code to enter at a link, and keeps the login in a Docker volume.

   ```bash
   docker compose run --rm auto-reviewer codex login --device-auth
   ```

4. Set `TZ` in `.env` to your time zone, for example `TZ=Europe/Berlin`, so the pause window uses your local time.

Then:

| To | Run |
| --- | --- |
| Start | `docker compose up -d --build` (or `npm run up`) |
| Stop | `docker compose down` (or `npm run down`) |
| Follow the log | `docker compose logs -f` (or `npm run logs`) |

The dashboard is at http://127.0.0.1:4477, published on this machine's loopback only. The `data` folder is shared with the container, so settings and history are the same as with `npm start`. Run only one of the two at a time. Stopping keeps queued and interrupted reviews; they continue on the next start.

The CLI versions are pinned in the `Dockerfile` (`CLAUDE_CODE_VERSION`, `CODEX_VERSION`). Change them and start again with `--build` to update. On Linux, the container runs as user ID 1000, so the `data` folder must be writable by it.

Codex runs each command in a read-only, offline sandbox, which needs Linux namespaces that Docker's default seccomp profile blocks. So `compose.yaml` turns seccomp off for this container, and in exchange drops every capability and blocks privilege escalation. On Linux hosts that restrict unprivileged user namespaces through AppArmor (Ubuntu 23.10 and later), also add `apparmor=unconfined` under `security_opt`.

## Dashboard

- **Queue:** live progress of running reviews, queued and waiting work, history, and a box to review any allowlisted PR on demand.
- **Job page:** the review from start to end, live while it runs:
  - **Evidence:** the diff (which files were in the prompt, too long to send, or excluded), linked issues, mentioned PRs, guidelines, file history and the prompt size.
  - **Code review and security review:** model, time, tokens in and out, tool calls, what each returned, and a step-by-step log of every command, tool call and reasoning note (click one for its output).
  - **Double-check, checking findings against the code, and posting.**

  Below that: every finding (including discarded ones and why), the timeline and the review text. In dry run, the review text is what would have been posted.
- **Leaderboard:**
  - **Models:** keep rate per model and pass, refuted findings, findings with bad evidence, speed, failures, and average tool calls and tokens per run.
  - **Repos:** clean-PR rate, findings per PR, blockers, security findings, requirement gaps.
  - **Authors:** the same metrics per author. They stay on your machine.

The keep rate is learned automatically. After you submit a draft, the app checks which of its comments you kept, edited or deleted.

## Settings

Everything is set on the dashboard's **Settings** page and stored in the app's database (`data/reviewer.sqlite`). A save is checked as a whole and applies without a restart. Review policies are captured when a job starts; model and review-budget changes apply to new jobs, while stricter approval restrictions also apply before posting. Defaults:

| Section | Setting | Default |
| --- | --- | --- |
| Repositories | Review pull requests in / Never review | None. Add `owner/repo` or `owner/*` |
| Posting to GitHub | Dry run | On |
| | How reviews are posted | Draft, with optional exceptions per repo |
| | Approve PRs that have no blockers | On, when confidence is at least high |
| Reviewer | Who reviews | Codex |
| | Review profile | Standard; select Strict for independent review and required coverage |
| | If Codex runs out, use Claude instead | On |
| | Double-check blockers and majors | On |
| | Codex models | `gpt-6.1-sol`, then `gpt-6-sol` |
| | Claude models | `claude-opus-5-5`, then `claude-opus-4-8` |
| Schedule | Check GitHub every | 5 seconds (one request per watched repo, free when nothing changed) |
| | Most reviews per hour | 6 |
| | Pause during part of the day | Off |
| | Rest a model after a usage limit | 30 minutes |
| Review limits | Large PR above | 1,500 changed lines (then only blockers and majors) |
| | Most nits per review | 5 |
| Files and authors | Leave out of reviews | Lockfiles, vendored and generated files |
| | Skip PRs by | dependabot, renovate, github-actions |
| Labels | While reviewing / Left feedback / Approved | `dh: on review`, `dh: feedback`, `dh: approved` |

Two things are set in `.env` instead, because the app needs them before the dashboard exists: `PORT` (default 4477) and `DATA_DIR` (default `./data`).

Upgrading from a version that used `reviewer.config.json`: the app imports that file the first time it starts, then renames it to `reviewer.config.imported.json`.

## How it watches GitHub

The app checks each watched repo's list of open pull requests and looks for ones that request you. Each check is a *conditional* request: it sends back the version it saw last time, and when nothing changed GitHub answers "304 Not Modified", which doesn't count against your rate limit. With nothing new happening, checking every 5 seconds costs nothing.

- Exact entries (`owner/repo`) are watched directly. Patterns (`owner/*`) are matched against the repos your login can access, a list refreshed every 10 minutes.
- Requests are sent one at a time, at least a second apart, so a long repo list stretches the cycle instead of bursting.
- If GitHub says the rate limit is reached, polling waits for the reset. If it asks the app to slow down without saying for how long, polling backs off for 1, 2, 4, 8 and then 15 minutes.
- Polling also stops while fewer than 300 requests are left in the hour, so posting reviews keeps working.
- Settings → GitHub usage shows each limit, what the last check cost, and the status of every watched repo.

Each copy of the app shares your account's limits with everything else on your login, so run one copy per login.

## Local repo copies

The first review of a repo downloads a full copy into `data/repos/`. Later reviews fetch only new commits, and each gets a throwaway worktree. From the local copy the app reads:
- diffs for follow-up reviews, and for big files whose diff GitHub leaves out
- the repo's guideline files from the base commit
- the recent history of each changed file, which goes into the prompt

That saves GitHub requests and gives the reviewer history to work with. The copies use as much disk as a normal clone. Deleting `data/repos/` is safe: it's downloaded again on the next review.

## Development

| Command | Does |
| --- | --- |
| `npm run dev` | API with auto-reload on port 4477 |
| `npm run dev:web` | Dashboard with hot reload on port 5173 (proxies to the API) |
| `npm test` | Tests for validation, review workflows, approval gates, routing, persistence and Strict coverage |
| `npm run typecheck` | Type-check the API and the dashboard |
| `npm run eval:strict -- results.json` | Compare human-adjudicated fixture reviews by profile |

The server runs TypeScript directly through Node's type stripping, so it has no build step. Only the dashboard is built, with Vite. State lives in `data/reviewer.sqlite`, using Node's built-in SQLite.

For environments that restrict the test runner's child processes, use `node --test --test-isolation=none test/*.test.ts`. The POSIX git-remote and shell-stand-in suites remain explicitly skipped on Windows.

Quality evaluation fixtures live in `test/fixtures/strict-reviews.json`. Run both profiles against the same fixtures, then have a human match each finding to an expected defect (or label it a false positive). Supply a JSON object with a `reviews` array. Each row has `caseId`, `profile` (`standard` or `strict`), `complete`, `durationMs`, nullable `inputTokens`/`outputTokens`, and `findings: [{ "matchedExpectedId": "expected-defect-id-or-null" }]` (use JSON `null` for a false positive). The evaluation command reports precision, recall, duplicates, incomplete runs, missing cases, runtime and token usage. These small synthetic fixtures support repeatable comparisons; mock-provider workflow tests do not establish real-model detection quality.

## Known limits

- One pending review per person per PR is a GitHub rule. If you're mid-way through your own review, the bot waits for you to submit or discard it.
- Requirement checks read GitHub issues only: issues the PR closes and issues mentioned in its description.
- A PR's `CLAUDE.md` may still be read by Claude as project memory. The instructions treat all repository content as untrusted, and draft mode means you see everything before anyone else does.
