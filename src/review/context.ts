import type { LoadedConfig } from '../config.ts';
import type { GitHub } from '../github/client.ts';
import { changedLineCount } from '../github/diff.ts';
import {
  compareCommits,
  getGuidelines,
  getLinkedIssues,
  listPrFiles,
  type LinkedIssue,
  type PrFile,
  type PrInfo,
} from '../github/prs.ts';
import type { Finding } from '../types.ts';

export interface ReviewContext {
  pr: PrInfo;
  me: string;
  prFiles: PrFile[]; // every file in the PR, used to validate comment positions
  reviewFiles: PrFile[]; // what this run reviews (all PR files, or just the new commits)
  excluded: string[];
  issues: LinkedIssue[];
  incremental: boolean;
  large: boolean;
  changedLines: number;
  previous: Finding[];
  prompt: string;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text);

// Keeps PR content from closing our delimiter early.
const fence = (kind: string, text: string) =>
  `<untrusted kind="${kind}">\n${text.replace(/<\/?untrusted/gi, (m) => m.replace('untrusted', 'untrusted_'))}\n</untrusted>`;

export async function buildContext(
  gh: GitHub,
  cfg: LoadedConfig,
  pr: PrInfo,
  sinceSha: string | null,
  previous: Finding[],
): Promise<ReviewContext> {
  const prFiles = await listPrFiles(gh, pr.repo, pr.number);
  let reviewFiles = prFiles;
  let incremental = false;
  if (sinceSha && sinceSha !== pr.headSha) {
    const delta = await compareCommits(gh, pr.repo, sinceSha, pr.headSha);
    if (delta) {
      // Only files that are still part of the PR; reverted changes don't need review.
      const inPr = new Set(prFiles.map((f) => f.filename));
      reviewFiles = delta.filter((f) => inPr.has(f.filename));
      incremental = true;
    }
  }

  const excluded = reviewFiles.filter((f) => cfg.isExcludedFile(f.filename)).map((f) => f.filename);
  const included = reviewFiles.filter((f) => !cfg.isExcludedFile(f.filename));
  const changedLines = changedLineCount(included);
  const large = changedLines > cfg.limits.largePrLines;

  const [issues, guidelines] = await Promise.all([getLinkedIssues(gh, pr), getGuidelines(gh, pr.repo, pr.baseSha)]);

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

  if (issues.length) {
    const text = issues
      .map((i) => {
        const comments = i.comments.length
          ? `\n### Comments\n${i.comments.map((c) => `- @${c.author}: ${clip(c.body, 1000)}`).join('\n')}`
          : '';
        return `## ${i.repo}#${i.number}: ${i.title}\n${clip(i.body || '(no description)', 6000)}${comments}`;
      })
      .join('\n\n');
    parts.push(fence('linked-issues', text));
  } else {
    parts.push('Linked issues: none found.');
  }

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

  return {
    pr,
    me: gh.me,
    prFiles,
    reviewFiles,
    excluded,
    issues,
    incremental,
    large,
    changedLines,
    previous,
    prompt: parts.join('\n\n'),
  };
}
