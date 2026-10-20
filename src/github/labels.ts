import { httpStatus, splitRepo, type GitHub } from './client.ts';

const COLORS: Record<string, string> = {
  running: 'fbca04',
  done: '0e8a16',
  blocker: 'b60205',
  failed: '6a737d',
};

const DESCRIPTIONS: Record<string, string> = {
  running: 'AI-assisted review in progress',
  done: 'AI-assisted review completed',
  blocker: 'AI-assisted review found at least one blocking issue',
  failed: 'AI-assisted review failed; will need a manual look',
};

const ensured = new Set<string>();

async function ensureLabel(gh: GitHub, repo: string, name: string) {
  const key = `${repo}:${name}`;
  if (ensured.has(key)) return;
  const kind = name.split(':').pop() ?? '';
  try {
    await gh.octokit.rest.issues.getLabel({ ...splitRepo(repo), name });
  } catch (err) {
    if (httpStatus(err) !== 404) throw err;
    await gh.octokit.rest.issues.createLabel({
      ...splitRepo(repo),
      name,
      color: COLORS[kind] ?? 'ededed',
      description: DESCRIPTIONS[kind],
    });
  }
  ensured.add(key);
}

// Returns false when the token can't label in this repo (you need at least triage access).
export async function addLabel(gh: GitHub, repo: string, number: number, name: string): Promise<boolean> {
  try {
    await ensureLabel(gh, repo, name);
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
