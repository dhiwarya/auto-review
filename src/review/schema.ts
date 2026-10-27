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
  required: ['summary', 'spec_alignment', 'findings', 'questions_for_author', 'resolved_previous_ids', 'review_confidence'],
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
    review_confidence: {
      type: 'object',
      additionalProperties: false,
      required: ['level', 'reason'],
      properties: {
        level: enumOf(['high', 'medium', 'low']),
        reason: str,
      },
    },
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

export const recheckSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'verdicts', 'review_confidence'],
  properties: {
    summary: str,
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'reason'],
        properties: {
          id: { type: 'integer' },
          status: enumOf(['open', 'resolved']),
          reason: str,
        },
      },
    },
    review_confidence: reviewSchema.properties.review_confidence,
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
  review_confidence: z.object({
    level: z.enum(['high', 'medium', 'low']),
    reason: z.string(),
  }),
});
export type ReviewOut = z.infer<typeof ReviewOut>;

const coverageJson = {
  type: 'object', additionalProperties: false,
  required: ['section_id', 'status', 'dependencies', 'tests', 'configuration', 'notes'],
  properties: {
    section_id: str, status: enumOf(['examined', 'unverified']),
    dependencies: { type: 'array', items: str }, tests: { type: 'array', items: str },
    configuration: { type: 'array', items: str }, notes: str,
  },
};
const requirementJson = {
  type: 'object', additionalProperties: false, required: ['ref', 'status', 'reason'],
  properties: { ref: str, status: enumOf(['aligned', 'partial', 'misaligned', 'not_checked']), reason: str },
};
export const strictReviewSchema = {
  ...reviewSchema,
  required: [...reviewSchema.required, 'coverage', 'requirements'],
  properties: { ...reviewSchema.properties,
    coverage: { type: 'array', items: coverageJson },
    requirements: { type: 'array', items: requirementJson },
  },
};
export const StrictReviewOut = ReviewOut.extend({
  coverage: z.array(z.object({
    section_id: z.string(), status: z.enum(['examined', 'unverified']),
    dependencies: z.array(z.string()), tests: z.array(z.string()), configuration: z.array(z.string()), notes: z.string(),
  })),
  requirements: z.array(z.object({ ref: z.string(), status: z.enum(['aligned', 'partial', 'misaligned', 'not_checked']), reason: z.string() })),
});
export type StrictReviewOut = z.infer<typeof StrictReviewOut>;

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

export const RecheckOut = z.object({
  summary: z.string(),
  verdicts: z.array(z.object({ id: z.number().int(), status: z.enum(['open', 'resolved']), reason: z.string() })),
  review_confidence: ReviewOut.shape.review_confidence,
});
export type RecheckOut = z.infer<typeof RecheckOut>;
