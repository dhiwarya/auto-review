import { z } from 'zod';

// JSON Schemas are written in the strict subset both CLIs accept: every property
// required, no extra properties, nullable via a type union.

const str = { type: 'string' } as const;
const enumOf = (values: string[]) => ({ type: 'string', enum: values });

const findingJson = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'severity', 'confidence', 'file', 'line', 'title', 'evidence', 'problem', 'suggestion'],
  properties: {
    category: enumOf(['bug', 'security', 'requirement', 'design', 'test', 'performance']),
    severity: enumOf(['blocker', 'major', 'minor', 'nit']),
    confidence: enumOf(['high', 'medium', 'low']),
    file: str,
    line: { type: ['integer', 'null'] },
    title: str,
    evidence: str,
    problem: str,
    suggestion: str,
  },
};

export const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'spec_alignment', 'findings', 'questions_for_author', 'resolved_previous_ids'],
  properties: {
    summary: str,
    spec_alignment: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'notes'],
      properties: {
        status: enumOf(['aligned', 'partial', 'misaligned', 'no_spec', 'not_checked']),
        notes: str,
      },
    },
    findings: { type: 'array', items: findingJson },
    questions_for_author: { type: 'array', items: str },
    resolved_previous_ids: { type: 'array', items: { type: 'integer' } },
  },
};

export const verifySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'adjusted_severity', 'reason'],
        properties: {
          id: { type: 'integer' },
          verdict: enumOf(['confirmed', 'refuted', 'uncertain']),
          adjusted_severity: enumOf(['blocker', 'major', 'minor', 'nit']),
          reason: str,
        },
      },
    },
  },
};

// Runtime checks of what actually came back.

const severity = z.enum(['blocker', 'major', 'minor', 'nit']);

export const FindingOut = z.object({
  category: z.enum(['bug', 'security', 'requirement', 'design', 'test', 'performance']),
  severity,
  confidence: z.enum(['high', 'medium', 'low']),
  file: z.string(),
  line: z.number().int().nullable(),
  title: z.string(),
  evidence: z.string(),
  problem: z.string(),
  suggestion: z.string(),
});
export type FindingOut = z.infer<typeof FindingOut>;

export const ReviewOut = z.object({
  summary: z.string(),
  spec_alignment: z.object({
    status: z.enum(['aligned', 'partial', 'misaligned', 'no_spec', 'not_checked']),
    notes: z.string(),
  }),
  findings: z.array(FindingOut),
  questions_for_author: z.array(z.string()),
  resolved_previous_ids: z.array(z.number().int()),
});
export type ReviewOut = z.infer<typeof ReviewOut>;

export const VerifyOut = z.object({
  verdicts: z.array(
    z.object({
      id: z.number().int(),
      verdict: z.enum(['confirmed', 'refuted', 'uncertain']),
      adjusted_severity: severity,
      reason: z.string(),
    }),
  ),
});
export type VerifyOut = z.infer<typeof VerifyOut>;
