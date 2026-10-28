import { httpStatus, splitRepo, type GitHub } from './client.ts';

export interface PrInfo {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  draft: boolean;
  state: string;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  requestedReviewers: string[];
  labels: string[];
}

export interface PrFile {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface LinkedIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  comments: { author: string; body: string }[];
  linkedBy: 'closes' | 'mentioned';
}

export interface LinkedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
}

export async function getPr(gh: GitHub, repo: string, number: number): Promise<PrInfo> {
  const { data } = await gh.octokit.rest.pulls.get({ ...splitRepo(repo), pull_number: number });
  return {
    repo: data.base.repo.full_name,
    number,
    title: data.title,
    body: data.body ?? '',
    url: data.html_url,
    author: data.user?.login ?? 'unknown',
    draft: Boolean(data.draft),
    state: data.state,
    headSha: data.head.sha,
    baseSha: data.base.sha,
    headRef: data.head.ref,
    baseRef: data.base.ref,
    additions: data.additions,
    deletions: data.deletions,
    changedFiles: data.changed_files,
    requestedReviewers: (data.requested_reviewers ?? []).map((u) => u.login),
    labels: (data.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
  };
}

export async function listPrFiles(gh: GitHub, repo: string, number: number): Promise<PrFile[]> {
  const files = await gh.octokit.paginate(gh.octokit.rest.pulls.listFiles, {
    ...splitRepo(repo),
    pull_number: number,
    per_page: 100,
  });
  return files.map((f) => ({
    filename: f.filename,
    previousFilename: f.previous_filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
}

export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
  // The review comment this one answers, for replies in a review thread.
  inReplyTo: number | null;
}

// What people said on the PR: every reply in a review thread, plus conversation comments
// made since `since`. Used to re-check findings without new commits.
export async function listDiscussion(gh: GitHub, repo: string, number: number, since: string): Promise<PrComment[]> {
  const [threads, conversation] = await Promise.all([
    gh.octokit.paginate(gh.octokit.rest.pulls.listReviewComments, { ...splitRepo(repo), pull_number: number, per_page: 100 }),
    gh.octokit.paginate(gh.octokit.rest.issues.listComments, { ...splitRepo(repo), issue_number: number, since, per_page: 100 }),
  ]);
  return [
    ...threads
      .filter((c) => c.in_reply_to_id)
      .map((c) => ({ author: c.user?.login ?? 'unknown', body: c.body, createdAt: c.created_at, inReplyTo: c.in_reply_to_id ?? null })),
    ...conversation.map((c) => ({ author: c.user?.login ?? 'unknown', body: c.body ?? '', createdAt: c.created_at, inReplyTo: null })),
  ];
}

// Files changed between the last reviewed commit and the new head. Returns null when the
// branch was rebased or force-pushed, in which case the caller falls back to a full review.
export async function compareCommits(gh: GitHub, repo: string, since: string, head: string): Promise<PrFile[] | null> {
  try {
    const { data } = await gh.octokit.rest.repos.compareCommitsWithBasehead({
      ...splitRepo(repo),
      basehead: `${since}...${head}`,
      per_page: 100,
    });
    if (data.status !== 'ahead') return null;
    return (data.files ?? []).map((f) => ({
      filename: f.filename,
      previousFilename: f.previous_filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }));
  } catch (err) {
    if (httpStatus(err) === 404) return null;
    throw err;
  }
}

const ISSUE_REF = /(?:^|[\s(,])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/g;

// Issues the PR closes (GitHub's own link), plus issues and other PRs mentioned in the
// description. Only issues go into the prompt; the PRs are shown as evidence.
export async function getLinkedRefs(gh: GitHub, pr: PrInfo, limit = 5, complete = false): Promise<{ issues: LinkedIssue[]; prs: LinkedPr[]; gaps: string[] }> {
  const refs = new Map<string, { repo: string; number: number; linkedBy: LinkedIssue['linkedBy'] }>();
  const gaps: string[] = [];
  const { owner, repo: name } = splitRepo(pr.repo);

  try {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const res: { repository: { pullRequest: { closingIssuesReferences: { nodes: { number: number; repository: { nameWithOwner: string } }[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } } } } = await gh.octokit.graphql(
      `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            closingIssuesReferences(first: 100, after: $cursor) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage endCursor } }
          }
        }
      }`,
      { owner, name, number: pr.number, cursor },
    );
    const connection = res.repository.pullRequest.closingIssuesReferences;
    for (const n of connection.nodes) {
      refs.set(`${n.repository.nameWithOwner}#${n.number}`, { repo: n.repository.nameWithOwner, number: n.number, linkedBy: 'closes' });
    }
    if (!complete || !connection.pageInfo?.hasNextPage) break;
    const next = connection.pageInfo.endCursor;
    if (!next || seenCursors.has(next)) throw new Error('closing-issue pagination did not advance');
    seenCursors.add(next);
    cursor = next;
    } while (true);
  } catch {
    // GraphQL can be unavailable for some tokens; description references still work.
    if (complete) gaps.push('Could not retrieve all closing-issue references from GitHub');
  }

  for (const m of pr.body.matchAll(ISSUE_REF)) {
    const repo = m[3] ?? m[1] ?? pr.repo;
    const number = Number(m[4] ?? m[2]);
    const key = `${repo}#${number}`;
    if (number && !refs.has(key)) refs.set(key, { repo, number, linkedBy: 'mentioned' });
  }

  const issues: LinkedIssue[] = [];
  const prs: LinkedPr[] = [];
  for (const ref of complete ? refs.values() : [...refs.values()].slice(0, limit * 2)) {
    if (!complete && issues.length >= limit) break;
    try {
      const { data } = await gh.octokit.rest.issues.get({ ...splitRepo(ref.repo), issue_number: ref.number });
      if (data.pull_request) {
        prs.push({ repo: ref.repo, number: ref.number, title: data.title, url: data.html_url });
        continue;
      }
      const params = {
        ...splitRepo(ref.repo),
        issue_number: ref.number,
        per_page: complete ? 100 : 10,
      };
      const comments = complete
        ? await gh.octokit.paginate(gh.octokit.rest.issues.listComments, params)
        : (await gh.octokit.rest.issues.listComments(params)).data;
      issues.push({
        repo: ref.repo,
        number: ref.number,
        title: data.title,
        body: data.body ?? '',
        url: data.html_url,
        comments: comments.map((c) => ({ author: c.user?.login ?? 'unknown', body: c.body ?? '' })),
        linkedBy: ref.linkedBy,
      });
    } catch {
      // No access to that repo, or the number isn't an issue. Skip it.
      if (complete) gaps.push(`Could not retrieve the complete issue and comments for ${ref.repo}#${ref.number}`);
    }
  }
  return { issues, prs, gaps };
}
