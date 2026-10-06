import { fail } from '@sveltejs/kit';
import {
  assignReviewerSchema,
  createReviewSchema,
  evidenceSchema,
  rejectReviewSchema,
  signReviewSchema,
  transitionSchema,
  updateTaskSchema,
  versionSchema
} from '$lib/models/signal';

export function load({ params }) {
  return { id: params.id };
}

const actorName = (formData: FormData) => String(formData.get('actor') ?? '安全评审专员');

function failure(error: { issues: Array<{ message: string }> }) {
  return fail(400, {
    message: error.issues[0]?.message ?? '表单校验失败'
  });
}

export const actions = {
  transition: async ({ request }) => {
    const formData = await request.formData();
    const parsed = transitionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      transition: parsed.data
    };
  },

  evidence: async ({ request }) => {
    const formData = await request.formData();
    const parsed = evidenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      evidence: {
        id: `E-${Date.now().toString(36)}`,
        type: parsed.data.evidenceType,
        title: parsed.data.title,
        source: parsed.data.source,
        strength: parsed.data.strength,
        batch: parsed.data.batch,
        note: parsed.data.note,
        createdAt: new Date().toISOString()
      },
      actor: actorName(formData)
    };
  },

  version: async ({ request }) => {
    const formData = await request.formData();
    const parsed = versionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      version: {
        id: `V-${Date.now().toString(36)}`,
        version: Number(formData.get('versionNumber') ?? 1),
        author: parsed.data.author,
        summary: parsed.data.summary,
        disposition: parsed.data.disposition,
        rationale: parsed.data.rationale,
        createdAt: new Date().toISOString()
      },
      actor: parsed.data.author
    };
  },

  requestReview: async ({ request }) => {
    const formData = await request.formData();
    const parsed = createReviewSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      requestReview: {
        id: parsed.data.id,
        purpose: parsed.data.purpose,
        actor: parsed.data.actor,
        basisVersionId: parsed.data.basisVersionId
      }
    };
  },

  signReview: async ({ request }) => {
    const formData = await request.formData();
    const parsed = signReviewSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      signReview: {
        id: parsed.data.id,
        sheetId: parsed.data.sheetId,
        actor: parsed.data.actor,
        expectedRevision: parsed.data.expectedRevision,
        checklist: {
          versionConfirmed: formData.get('versionConfirmed') === 'on',
          batchesConfirmed: formData.get('batchesConfirmed') === 'on',
          tasksConfirmed: formData.get('tasksConfirmed') === 'on'
        }
      }
    };
  },

  assignReviewer: async ({ request }) => {
    const formData = await request.formData();
    const parsed = assignReviewerSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      assignReviewer: parsed.data
    };
  },

  rejectReview: async ({ request }) => {
    const formData = await request.formData();
    const parsed = rejectReviewSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      rejectReview: parsed.data
    };
  },

  updateTask: async ({ request }) => {
    const formData = await request.formData();
    const parsed = updateTaskSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return { success: true, updateTask: parsed.data };
  },

  reopen: async ({ request }) => {
    const formData = await request.formData();
    const actor = actorName(formData);
    const reason = String(formData.get('reason') ?? '').trim();
    const id = String(formData.get('id') ?? '');

    if (reason.length < 6) return fail(400, { message: '重新打开原因至少 6 个字符。' });

    return {
      success: true,
      reopen: { id, actor, reason, createdAt: new Date().toISOString() }
    };
  }
};
