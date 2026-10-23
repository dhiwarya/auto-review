import type { SettingsStore } from '../settings.ts';
import type { RepoCache } from '../git/mirror.ts';
import type { GitHub } from '../github/client.ts';
import { changedLineCount } from '../github/diff.ts';
import {
  compareCommits,
  getLinkedRefs,
  listPrFiles,
  type LinkedIssue,
  type LinkedPr,
  type PrComment,
  type PrFile,
  type PrInfo,
} from '../github/prs.ts';
import { SIGNATURE } from '../github/publish.ts';
import type { Evidence, Finding } from '../types.ts';

export interface ReviewContext {
  pr: PrInfo;
  me: string;
  prFiles: PrFile[]; // every file in the PR, used to validate comment positions
  reviewFiles: PrFile[]; // what this run reviews (all PR files, or just the new commits)
  excluded: string[];
  issues: LinkedIssue[];
  incremental: boolean;
  large: boolean;
  // Some files' diffs didn't fit; the model was told to read them in the checkout.
  truncated: boolean;
  changedLines: number;
  previous: Finding[];
  prompt: string;
  evidence: Evidence;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text);

// Keeps PR content from closing our delimiter early.
const fence = (kind: string, text: string) =>
  `<untrusted kind="${kind}">\n${text.replace(/<\/?untrusted/gi, (m) => m.replace('untrusted', 'untrusted_'))}\n</untrusted>`;

const GUIDELINE_FILES = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md'];

function issuesSection(issues: LinkedIssue[]): string {
  if (!issues.length) return 'Linked issues: none found.';
  const text = issues
    .map((i) => {
      const comments = i.comments.length
        ? `\n### Comments\n${i.comments.map((c) => `- @${c.author}: ${clip(c.body, 1000)}`).join('\n')}`
        : '';
      return `## ${i.repo}#${i.number}: ${i.title}\n${clip(i.body || '(no description)', 6000)}${comments}`;
    })
    .join('\n\n');
  return fence('linked-issues', text);
}

// The re-check's prompt: the findings still open, each with the replies in its thread,
// and the PR conversation since the last review. Comments the app wrote are left out.
export function recheckPrompt(pr: PrInfo, findings: Finding[], discussion: PrComment[], issues: LinkedIssue[]): string {
  const said = discussion.filter((c) => !c.body.includes(SIGNATURE));
  const quote = (cs: PrComment[]) => clip(cs.map((c) => `@${c.author} (${c.createdAt}): ${clip(c.body, 2000)}`).join('\n\n'), 8000);

  const parts: string[] = [];
  parts.push(`# Pull request ${pr.repo}#${pr.number}`);
  parts.push(
    `Author: ${pr.author}. Head: ${pr.headRef} (${pr.headSha.slice(0, 7)}). You reviewed this commit before, and there are no new commits since.`,
  );
  parts.push(fence('pr-title-and-description', `Title: ${pr.title}\n\n${clip(pr.body || '(no description)', 8000)}`));
  parts.push(issuesSection(issues));

  const list = findings.map((f) => {
    const replies = f.comment_id ? said.filter((c) => c.inReplyTo === f.comment_id) : [];
    return [
      `### Finding id ${f.id}`,
      `${f.severity} · ${f.category} · ${f.file}${f.line ? `:${f.line}` : ''}`,
      `Title: ${f.title}`,
      `Problem: ${f.problem}`,
      `Evidence:\n${f.evidence}`,
      `Suggestion: ${f.suggestion}`,
      replies.length ? fence('replies-in-this-finding-thread', quote(replies)) : 'No replies in its thread.',
    ].join('\n');
  });
  parts.push(`## Findings still open (${findings.length})\n\n${list.join('\n\n')}`);

  const conversation = said.filter((c) => c.inReplyTo === null);
  parts.push(conversation.length ? fence('pr-conversation since the last review', quote(conversation)) : 'No PR conversation since the last review.');
  return parts.join('\n\n');
}

export async function buildContext(
  gh: GitHub,
  cfg: SettingsStore,
  pr: PrInfo,
  sinceSha: string | null,
  previous: Finding[],
  cache: RepoCache,
): Promise<ReviewContext> {
  // GitHub's file list stays the reference for where inline comments may go.
  const prFiles = await listPrFiles(gh, pr.repo, pr.number);
  const mergeBase = await cache.mergeBase(pr.repo, pr.baseSha, pr.headSha);
  let reviewFiles = prFiles;
  let incremental = false;
  if (sinceSha && sinceSha !== pr.headSha) {
    let delta: PrFile[] | null = null;
    if (await cache.hasCommit(pr.repo, sinceSha)) {
      // A rebase or force-push means the old commit isn't an ancestor: review everything again.
      if (await cache.isAncestor(pr.repo, sinceSha, pr.headSha)) delta = await cache.diffFiles(pr.repo, sinceSha, pr.headSha);
    } else {
      delta = await compareCommits(gh, pr.repo, sinceSha, pr.headSha); // reviewed before the local copy existed
    }
    if (delta) {
      // Only files that are still part of the PR; reverted changes don't need review.
      const inPr = new Set(prFiles.map((f) => f.filename));
      reviewFiles = delta.filter((f) => inPr.has(f.filename));
      incremental = true;
    }
  }

  // GitHub leaves out the diff of very large files; the local copy has it.
  const diffFrom = incremental ? sinceSha! : mergeBase;
  const promptFiles: PrFile[] = [];
  for (const f of reviewFiles) {
    const patch = f.patch ?? (await cache.filePatch(pr.repo, diffFrom, pr.headSha, f.filename, f.previousFilename).catch(() => undefined));
    promptFiles.push({ ...f, patch });
  }

  const excluded = reviewFiles.filter((f) => cfg.isExcludedFile(f.filename)).map((f) => f.filename);
  const included = promptFiles.filter((f) => !cfg.isExcludedFile(f.filename));
  const changedLines = changedLineCount(included);
  const large = changedLines > cfg.limits.largePrLines;

  const { issues, prs } = await getLinkedRefs(gh, pr);
  // Read from the base commit so the PR can't rewrite its own review rules.
  const guidelines: { path: string; text: string }[] = [];
  for (const file of GUIDELINE_FILES) {
    const text = await cache.readFile(pr.repo, pr.baseSha, file);
    if (text) guidelines.push({ path: file, text });
  }
  // What happened to these files before the PR: helps judge intent and spot regressions.
  const history = await cache.history(
    pr.repo,
    mergeBase,
    included.filter((f) => f.status !== 'added').slice(0, 15).map((f) => f.previousFilename ?? f.filename),
  );

  const parts: string[] = [];
  parts.push(`# Pull request ${pr.repo}#${pr.number}`);
  parts.push(
    `Author: ${pr.author}. Base: ${pr.baseRef} (${pr.baseSha.slice(0, 7)}). Head: ${pr.headRef} (${pr.headSha.slice(0, 7)}). ` +
      `${prFiles.length} files changed in total, +${pr.additions} −${pr.deletions}.`,
  );
  if (incremental) {
    parts.push(
      `This is a follow-up review. You already reviewed this PR at ${sinceSha!.slice(0, 7)}. ` +
        'Review only the changes since then (the diff below), plus whether they fix the previously raised findings.',
    );
  }
  if (large) {
    parts.push(
      `This is a large change (${changedLines} changed lines). Report only blocker and major findings, at most 10, ` +
        'and say in the summary that the review focused on the highest risks.',
    );
  }

  parts.push(fence('pr-title-and-description', `Title: ${pr.title}\n\n${clip(pr.body || '(no description)', 8000)}`));

  parts.push(issuesSection(issues));

  if (guidelines.length) {
    parts.push(
      fence(
        'repository-guidelines (from the base branch)',
        guidelines.map((g) => `## ${g.path}\n${clip(g.text, 4000)}`).join('\n\n'),
      ),
    );
  }

  if (previous.length) {
    parts.push(
      '## Previously raised findings on this PR\n' +
        previous.map((f) => `- [id ${f.id}] ${f.severity} ${f.category} ${f.file}${f.line ? `:${f.line}` : ''}: ${f.title}`).join('\n') +
        '\nDon\'t raise these again. List any the current code fixes in resolved_previous_ids.',
    );
  }

  if (history.length) {
    parts.push(
      fence(
        'file-history (recent commits to the changed files, before this PR)',
        history.map((h) => `${h.file}\n${h.commits.map((c) => `  ${c.sha} ${c.date} ${c.author}: ${c.subject}`).join('\n')}`).join('\n'),
      ),
    );
  }

  const fileList = reviewFiles
    .map((f) => `- ${f.filename} (${f.status}, +${f.additions} −${f.deletions})${cfg.isExcludedFile(f.filename) ? ' [excluded: generated or lock file]' : ''}`)
    .join('\n');
  parts.push(`## Files in this review (${reviewFiles.length})\n${fileList}`);

  let diff = '';
  const omitted: string[] = [];
  for (const f of included) {
    const chunk = `diff --git a/${f.previousFilename ?? f.filename} b/${f.filename}\n${f.patch ?? '(binary or too large for an inline diff: read the file instead)'}\n`;
    if (diff.length + chunk.length > cfg.limits.maxDiffChars) omitted.push(f.filename);
    else diff += chunk;
  }
  parts.push(fence('diff', diff || '(no reviewable diff)'));
  if (omitted.length) {
    parts.push(`The diff was too long to include in full. Read these files in the checkout instead:\n${omitted.map((f) => `- ${f}`).join('\n')}`);
  }
  const prompt = parts.join('\n\n');

  const evidence: Evidence = {
    diff: {
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      sinceSha: incremental ? sinceSha : null,
      prFiles: prFiles.length,
      files: reviewFiles.map((f) => ({
        name: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        state: cfg.isExcludedFile(f.filename) ? 'excluded' : omitted.includes(f.filename) ? 'too_long' : 'reviewed',
      })),
      changedLines,
      diffChars: diff.length,
      maxDiffChars: cfg.limits.maxDiffChars,
      large,
    },
    ...refsEvidence(issues, prs),
    guidelines: guidelines.map((g) => g.path),
    history: history.map((h) => ({ file: h.file, commits: h.commits.length })),
    previousFindings: previous.length,
    discussion: null,
    promptChars: prompt.length,
  };

  return {
    pr,
    me: gh.me,
    prFiles,
    reviewFiles,
    excluded,
    issues,
    incremental,
    large,
    truncated: omitted.length > 0,
    changedLines,
    previous,
    prompt,
    evidence,
  };
}

export function refsEvidence(issues: LinkedIssue[], prs: LinkedPr[]): Pick<Evidence, 'issues' | 'prs'> {
  return {
    issues: issues.map((i) => ({ ref: `${i.repo}#${i.number}`, title: i.title, url: i.url, comments: i.comments.length, linkedBy: i.linkedBy })),
    prs: prs.map((p) => ({ ref: `${p.repo}#${p.number}`, title: p.title, url: p.url })),
  };
}
