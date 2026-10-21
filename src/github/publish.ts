import { errorText, httpStatus, splitRepo, type GitHub } from './client.ts';

export interface InlineComment {
  findingId: number;
  path: string;
  line: number;
  body: string;
}

export interface PostedReview {
  id: number;
  url: string;
  state: string;
  // finding id -> GitHub comment id
  commentIds: Map<number, number>;
}

// GitHub allows one pending review per person per PR.
export class PendingReviewExists extends Error {}

export const findingMarker = (id: number) => `<!-- ai-finding:${id} -->`;
const FINDING_MARKER = /<!-- ai-finding:(\d+) -->/;

// The last line of every comment the app writes.
export const SIGNATURE = '<sub>Auto Reviewer</sub>';

// null posts a pending draft that only you can see until you submit it.
export type ReviewEvent = 'COMMENT' | 'APPROVE' | null;

export async function postReview(
  gh: GitHub,
  repo: string,
  number: number,
  headSha: string,
  event: ReviewEvent,
  body: string,
  comments: InlineComment[],
): Promise<PostedReview & { droppedInline: boolean }> {
  const create = (withComments: InlineComment[], reviewBody = body) =>
    gh.octokit.rest.pulls.createReview({
      ...splitRepo(repo),
      pull_number: number,
      commit_id: headSha,
      body: reviewBody,
      ...(event ? { event } : {}),
      comments: withComments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT' as const, body: c.body })),
    });

  let droppedInline = false;
  let res;
  try {
    res = await create(comments);
  } catch (err) {
    const text = errorText(err);
    if (httpStatus(err) === 422 && /pending review/i.test(text)) throw new PendingReviewExists(text);
    // A line GitHub won't accept fails the whole review. Retry once with everything in the body.
    if (httpStatus(err) === 422 && comments.length) {
      droppedInline = true;
      const moved = comments.map((c) => `**\`${c.path}:${c.line}\`**\n\n${c.body.replace(SIGNATURE, '').trim()}`).join('\n\n---\n\n');
      res = await create([], insertBeforeSignature(body, `**Findings on changed lines**\n\n${moved}`));
    } else {
      throw err;
    }
  }

  const review = res.data;
  const commentIds = new Map<number, number>();
  if (!droppedInline && comments.length) {
    for (const c of await listReviewComments(gh, repo, number, review.id)) {
      const m = FINDING_MARKER.exec(c.body);
      if (m) commentIds.set(Number(m[1]), c.id);
    }
  }
  return { id: review.id, url: review.html_url, state: review.state, commentIds, droppedInline };
}

function insertBeforeSignature(body: string, section: string): string {
  const at = body.lastIndexOf(SIGNATURE);
  return at < 0 ? `${body}\n\n${section}` : `${body.slice(0, at)}${section}\n\n${body.slice(at)}`;
}

// Your standing verdict on the PR from your own reviews: the latest approval or change
// request counts, comments don't. null when you have neither.
export async function myVerdict(gh: GitHub, repo: string, number: number): Promise<'APPROVED' | 'CHANGES_REQUESTED' | null> {
  const reviews = await gh.octokit.paginate(gh.octokit.rest.pulls.listReviews, { ...splitRepo(repo), pull_number: number, per_page: 100 });
  let verdict: 'APPROVED' | 'CHANGES_REQUESTED' | null = null;
  for (const r of reviews) {
    if (r.user?.login?.toLowerCase() !== gh.me.toLowerCase()) continue;
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') verdict = r.state;
    if (r.state === 'DISMISSED') verdict = null;
  }
  return verdict;
}

export async function listReviewComments(gh: GitHub, repo: string, number: number, reviewId: number) {
  const items = await gh.octokit.paginate(gh.octokit.rest.pulls.listCommentsForReview, {
    ...splitRepo(repo),
    pull_number: number,
    review_id: reviewId,
    per_page: 100,
  });
  return items.map((c) => ({ id: c.id, body: c.body, path: c.path, line: c.line ?? c.original_line ?? null }));
}

// null when the review no longer exists (you discarded the draft).
export async function getReview(gh: GitHub, repo: string, number: number, reviewId: number): Promise<{ state: string; body: string } | null> {
  try {
    const { data } = await gh.octokit.rest.pulls.getReview({ ...splitRepo(repo), pull_number: number, review_id: reviewId });
    return { state: data.state, body: data.body ?? '' };
  } catch (err) {
    if (httpStatus(err) === 404) return null;
    throw err;
  }
}

export { FINDING_MARKER };
