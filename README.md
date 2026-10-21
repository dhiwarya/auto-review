# Auto Reviewer

A personal review agent that runs on your own machine. When someone requests your review on GitHub, it reviews the PR with your own Claude Code and Codex logins and leaves a **draft review that only you can see**. You edit it and submit it yourself. A local dashboard shows the queue, live progress and leaderboards.

## What a review covers

One provider does the whole review: **Codex** by default (Sol 6.1, then Sol 6), with **Claude** taking over only if Codex runs out (Opus 5.5, then Opus 4.8). You can switch providers, or turn the fallback off, on the dashboard's Settings page.

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

## Lifecycle

```
review requested ─► queued ─► reviewing ─► posted ─► approved, or feedback
                                  │
       new commits pushed ────────┤ (follow-up review of only the new commits; fixed findings are listed)
       request removed/PR closed ─┤ cancelled
       both models at their limit ┤ waiting until the limit resets
       you have a pending review  ┤ waiting until you submit or discard it
       3 failed attempts ─────────┴ failed (shown on the dashboard)
```

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

A published review **approves the PR** when no blocker is open (in this review or an earlier one on the PR) and the confidence is at least the minimum set in Settings (high by default). It never approves a draft (you decide when you submit it), a draft PR, your own PR, a PR with commits newer than the review, or one where you requested changes yourself. Otherwise it posts a comment review, and the dashboard says why it didn't approve. An approval counts toward branch protection, so the PR may become mergeable.

## Safety model

- **Only the repos you list in Settings** are ever reviewed. Keep public repos where strangers open PRs out of that list.
- **Read-only agents.** Claude runs as `claude -p --restricted --tools Read,Grep,Glob`, with no MCP servers and no project settings or hooks loaded from the PR, so it can only read files. Codex runs as `codex exec --sandbox read-only`, with no user config, no rules and no `AGENTS.md`. Codex works through shell commands, so its instructions forbid running, building, installing or testing anything from the repository. Its sandbox also blocks file writes and network access, and any credential that shows up in its output is dropped.
- **The agents never see your GitHub token.** They get an allowlisted environment, and their only output is JSON. The app does all GitHub writes itself.
- **Throwaway checkouts.** Each review gets its own worktree of the PR head in a temp folder, made from the local repo copy, with symlinks disabled. It's deleted afterwards. Your GitHub token is passed to git through the environment and never written into the local copy.
- **Approves only under strict rules, never requests changes.** Draft mode posts a pending review. Publish mode approves when the rules in [Confidence and approval](#confidence-and-approval) allow it, and posts a comment review otherwise. Text in a PR can't raise the confidence: the hard rules are checked by the app, not the model.
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

## Dashboard

- **Queue:** live progress of running reviews, queued and waiting work, history, and a box to review any allowlisted PR on demand.
- **Job page:** every finding (including discarded ones and why), the timeline, model runs with their tool calls and tokens, and the review text. In dry run, the review text is what would have been posted.
- **Leaderboard:**
  - **Models:** keep rate per model and pass, refuted findings, findings with bad evidence, speed, failures, and average tool calls and tokens per run.
  - **Repos:** clean-PR rate, findings per PR, blockers, security findings, requirement gaps.
  - **Authors:** the same metrics per author. They stay on your machine.

The keep rate is learned automatically. After you submit a draft, the app checks which of its comments you kept, edited or deleted.

## Settings

Everything is set on the dashboard's **Settings** page and stored in the app's database (`data/reviewer.sqlite`). A save is checked as a whole and applies straight away, with no restart. Defaults:

| Section | Setting | Default |
| --- | --- | --- |
| Repositories | Review pull requests in / Never review | None. Add `owner/repo` or `owner/*` |
| Posting to GitHub | Dry run | On |
| | How reviews are posted | Draft, with optional exceptions per repo |
| | Approve PRs that have no blockers | On, when confidence is at least high |
| Reviewer | Who reviews | Codex |
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
| `npm test` | Unit tests for diff parsing and finding validation |
| `npm run typecheck` | Type-check the API and the dashboard |

The server runs TypeScript directly through Node's type stripping, so it has no build step. Only the dashboard is built, with Vite. State lives in `data/reviewer.sqlite`, using Node's built-in SQLite.

## Known limits

- One pending review per person per PR is a GitHub rule. If you're mid-way through your own review, the bot waits for you to submit or discard it.
- Requirement checks read GitHub issues only: issues the PR closes and issues mentioned in its description.
- A PR's `CLAUDE.md` may still be read by Claude as project memory. The instructions treat all repository content as untrusted, and draft mode means you see everything before anyone else does.
