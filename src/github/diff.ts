// Parsing of GitHub's per-file unified patches.

export interface ParsedPatch {
  // New-file line numbers GitHub accepts for an inline comment on the RIGHT side
  // (added lines and context lines inside a hunk).
  commentableLines: Set<number>;
  addedLines: Map<number, string>;
  removedText: string[];
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string | undefined | null): ParsedPatch {
  const commentableLines = new Set<number>();
  const addedLines = new Map<number, string>();
  const removedText: string[] = [];
  if (!patch) return { commentableLines, addedLines, removedText };

  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === '+') {
      commentableLines.add(newLine);
      addedLines.set(newLine, text);
      newLine++;
    } else if (marker === '-') {
      removedText.push(text);
    } else {
      commentableLines.add(newLine);
      newLine++;
    }
  }
  return { commentableLines, addedLines, removedText };
}

// Count of changed lines, used to decide whether a PR is "large".
export function changedLineCount(files: { additions: number; deletions: number }[]): number {
  return files.reduce((n, f) => n + f.additions + f.deletions, 0);
}
