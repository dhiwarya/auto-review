import fs from 'node:fs';
import { evaluateReviews } from '../src/review/evaluation.ts';

const input = process.argv[2];
if (!input) {
  console.error('Usage: npm run eval:strict -- path/to/adjudicated-results.json');
  process.exitCode = 1;
} else {
  const fixtures = JSON.parse(fs.readFileSync(new URL('../test/fixtures/strict-reviews.json', import.meta.url), 'utf8'));
  const results = JSON.parse(fs.readFileSync(input, 'utf8'));
  console.log(JSON.stringify(evaluateReviews(fixtures, results), null, 2));
}
