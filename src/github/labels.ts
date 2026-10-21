import { httpStatus, splitRepo, type GitHub } from './client.ts';

export type LabelKind = 'reviewing' | 'feedback' | 'approved';
export type LabelNames = Record<LabelKind, string>;

const LOOK: Record<LabelKind, { color: string; description: string }> = {
  reviewing: { color: 'fbca04', description: 'Auto Reviewer: review in progress' },
  feedback: { color: 'd93f0b', description: 'Auto Reviewer: left feedback' },
  approved: { color: '0e8a16', description: 'Auto Reviewer: approved' },
};

// Labels earlier versions set. They're taken off a PR when it gets one of the new ones.
export const LEGACY_LABELS = ['ai-review:running', 'ai-review:done', 'ai-review:blocker', 'ai-review:failed'];

const ensured = new Set<string>();

async function ensureLabel(gh: GitHub, repo: string, name: string, kind: LabelKind) {
  const key = `${repo}:${name}`;
  if (ensured.has(key)) return;
  try {
    await gh.octokit.rest.issues.getLabel({ ...splitRepo(repo), name });
  } catch (err) {
    if (httpStatus(err) !== 404) throw err;
    await gh.octokit.rest.issues.createLabel({ ...splitRepo(repo), name, ...LOOK[kind] });
  }
  ensured.add(key);
}

// Returns false when the token can't label in this repo (you need at least triage access).
async function addLabel(gh: GitHub, repo: string, number: number, name: string, kind: LabelKind): Promise<boolean> {
  try {
    await ensureLabel(gh, repo, name, kind);
    await gh.octokit.rest.issues.addLabels({ ...splitRepo(repo), issue_number: number, labels: [name] });
    return true;
  } catch (err) {
    const status = httpStatus(err);
    if (status === 403 || status === 404 || status === 422) return false;
    throw err;
  }
}

export async function removeLabel(gh: GitHub, repo: string, number: number, name: string): Promise<void> {
  try {
    await gh.octokit.rest.issues.removeLabel({ ...splitRepo(repo), issue_number: number, name });
  } catch (err) {
    const status = httpStatus(err);
    if (status === 403 || status === 404) return;
    throw err;
  }
}

// Makes `kind` the one Auto Reviewer label on the PR. `present` is the PR's current labels
// when known, so only labels that are actually there get removed. Returns false when the
// token can't label in this repo.
export async function showLabel(
  gh: GitHub,
  repo: string,
  number: number,
  names: LabelNames,
  kind: LabelKind,
  present?: string[],
): Promise<boolean> {
  const has = (name: string) => !present || present.some((p) => p.toLowerCase() === name.toLowerCase());
  const ok = present && has(names[kind]) ? true : await addLabel(gh, repo, number, names[kind], kind);
  const others = [...Object.values(names), ...LEGACY_LABELS].filter((n) => n.toLowerCase() !== names[kind].toLowerCase());
  for (const name of others) if (has(name)) await removeLabel(gh, repo, number, name);
  return ok;
}
