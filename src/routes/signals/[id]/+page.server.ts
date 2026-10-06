import { fail } from '@sveltejs/kit';
import {
  evidenceSchema,
  requestReviewSchema,
  signReviewSchema,
  taskSchema,
  transitionSchema,
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

function tokenOf(formData: FormData) {
  return String(formData.get('storeToken') ?? '');
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
      actor: actorName(formData),
      token: tokenOf(formData)
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
      actor: parsed.data.author,
      token: tokenOf(formData)
    };
  },

  // 处置人发起双人复核：生成待签复核单并完成处置人签署
  requestReview: async ({ request }) => {
    const formData = await request.formData();
    const parsed = requestReviewSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      requestReview: {
        id: parsed.data.id,
        target: parsed.data.target,
        handler: parsed.data.handler,
        reason: parsed.data.reason,
        versionId: parsed.data.versionId,
        token: parsed.data.storeToken
      }
    };
  },

  // 独立复核人（或处置人补签）在复核单上逐项确认后签署
  signReview: async ({ request }) => {
    const formData = await request.formData();
    const parsed = signReviewSchema.safeParse({
      ...Object.fromEntries(formData),
      confirmsTask: formData.getAll('confirmsTask')
    });
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      signReview: {
        id: parsed.data.id,
        sheetId: parsed.data.sheetId,
        role: parsed.data.role,
        actor: parsed.data.actor,
        baseRevision: parsed.data.baseRevision,
        token: parsed.data.storeToken,
        confirmsVersion: true,
        confirmsBatches: true,
        confirmedTaskIds: parsed.data.confirmsTask
      }
    };
  },

  task: async ({ request }) => {
    const formData = await request.formData();
    const parsed = taskSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      task: {
        id: parsed.data.id,
        taskId: parsed.data.taskId,
        status: parsed.data.status,
        actor: parsed.data.actor,
        token: tokenOf(formData)
      }
    };
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
