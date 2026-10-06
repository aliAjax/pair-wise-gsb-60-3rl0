import type {
  CaseVersion,
  EvidenceItem,
  InvestigationTask,
  ReviewChecklist,
  ReviewPurpose,
  ReviewSheet,
  RiskLevel,
  SignalCase,
  SignalStatus
} from '$lib/models/signal';

export class ReviewError extends Error {
  /** conflict=true 表示乐观锁冲突：另一窗口已先完成签署 */
  conflict: boolean;
  constructor(message: string, conflict = false) {
    super(message);
    this.name = 'ReviewError';
    this.conflict = conflict;
  }
}

export type StoreResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; message: string; conflict?: boolean };

export const reviewPurposeLabels: Record<ReviewPurpose, string> = {
  action_required: '进入待处置',
  closed: '关闭信号'
};

export const sheetStatusLabels = {
  pending: '待签署',
  completed: '复核完成',
  voided: '已失效'
} as const;

/** 高及以上风险信号才强制双人复核 */
export function requiresDualReview(riskLevel: RiskLevel): boolean {
  return riskLevel === 'high' || riskLevel === 'critical';
}

export function activeSheet(signal: SignalCase): ReviewSheet | undefined {
  return signal.reviewSheets.find((sheet) => sheet.status === 'pending');
}

function stableFingerprint(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input && typeof input === 'object') {
      return Object.keys(input as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = sortKeys((input as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return input;
  };
  return JSON.stringify(sortKeys(value));
}

/**
 * 复核依据指纹：覆盖证据矩阵与全部结论版本。
 * 新增/修改证据、形成新版本都会改变指纹，使原签署失效。
 */
export function evidenceBasisFingerprint(
  evidence: EvidenceItem[],
  versions: CaseVersion[]
): string {
  const digest = (input: string) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return digest(stableFingerprint({ evidence, versions }));
}

export function basisStillValid(signal: SignalCase, sheet: ReviewSheet): boolean {
  return (
    sheet.basisFingerprint ===
    evidenceBasisFingerprint(signal.evidence, signal.versions)
  );
}

export function openTasks(tasks: InvestigationTask[]): InvestigationTask[] {
  return tasks.filter((task) => task.status !== 'done');
}

interface BuildSheetInput {
  id: string;
  purpose: ReviewPurpose;
  fromStatus: SignalStatus;
  signal: SignalCase;
  basisVersionId: string;
  handler: string;
  createdAt: string;
}

/** 构造复核单并锁定依据快照（结论版本、批号、未完成任务、证据指纹） */
export function buildReviewSheet(input: BuildSheetInput): ReviewSheet {
  const { id, purpose, fromStatus, signal, basisVersionId, handler, createdAt } = input;
  const basisVersion = signal.versions.find((version) => version.id === basisVersionId);
  if (!basisVersion) throw new ReviewError('所选结论版本不存在，请重新选择。');

  return {
    id,
    purpose,
    status: 'pending',
    fromStatus,
    basisVersionId,
    basisVersionLabel: `V${basisVersion.version} · ${basisVersion.summary}`,
    basisBatches: [...signal.affectedBatches],
    basisOpenTasks: openTasks(signal.tasks).map((task) => ({
      id: task.id,
      title: task.title,
      owner: task.owner
    })),
    basisFingerprint: evidenceBasisFingerprint(signal.evidence, signal.versions),
    handlerSignature: { actor: handler, signedAt: createdAt },
    reviewer: null,
    reviewerSignature: null,
    rejectionReason: null,
    voidedReason: null,
    revision: 0,
    createdAt,
    completedAt: null
  };
}

export interface SignReviewInput {
  sheet: ReviewSheet;
  actor: string;
  expectedRevision: number;
  signal: SignalCase;
  checklist?: {
    versionConfirmed?: boolean;
    batchesConfirmed?: boolean;
    tasksConfirmed?: boolean;
  };
  signedAt: string;
}

/**
 * 施加复核人签署（处置人签署在发起复核单时完成）。
 * 纯函数，返回新的复核单；不满足双人复核规则时抛 ReviewError。
 * expectedRevision 与当前 revision 不一致即判定为后到一方（并发冲突）。
 */
export function applySignature(input: SignReviewInput): ReviewSheet {
  const { sheet, actor, expectedRevision, signal, checklist, signedAt } = input;

  if (expectedRevision !== sheet.revision) {
    throw new ReviewError(
      `复核单已被其他操作更新（修订 ${expectedRevision} → ${sheet.revision}），请刷新后查看最新状态。`,
      true
    );
  }
  if (sheet.status !== 'pending') {
    throw new ReviewError('该复核单已失效或已完成，不能继续签署；请发起新的复核。');
  }
  if (!basisStillValid(signal, sheet)) {
    throw new ReviewError('证据或结论版本已变化，原复核依据失效，需重新发起复核。');
  }
  const currentVersion = signal.versions[0];
  if (!currentVersion || currentVersion.id !== sheet.basisVersionId) {
    throw new ReviewError('结论版本已更新，请基于最新版本重新发起复核。');
  }

  const signed: ReviewChecklist = {
    versionConfirmed: checklist?.versionConfirmed === true,
    batchesConfirmed: checklist?.batchesConfirmed === true,
    tasksConfirmed: checklist?.tasksConfirmed === true
  };

  if (!sheet.handlerSignature) {
    throw new ReviewError('处置人尚未签署，复核人不能先行签署。');
  }
  if (sheet.reviewerSignature) {
    throw new ReviewError('该复核单已有有效复核签署，不能产生第二份签署。');
  }
  if (actor.trim() === sheet.handlerSignature.actor) {
    throw new ReviewError('复核人必须是独立于处置人的账号，不能批准自己的复核。');
  }
  if (sheet.reviewer && actor !== sheet.reviewer) {
    throw new ReviewError(`当前复核单已指派给 ${sheet.reviewer}，只有被指派人可以签署。`);
  }
  if (!signed.versionConfirmed || !signed.batchesConfirmed || !signed.tasksConfirmed) {
    throw new ReviewError('请逐项确认结论版本、关联批号与未完成调查任务后再签署。');
  }
  const remaining = openTasks(signal.tasks);
  if (sheet.purpose === 'closed' && remaining.length > 0) {
    throw new ReviewError(
      `仍有 ${remaining.length} 项未完成调查任务（${remaining.map((t) => t.title).join('、')}），不能签署关闭。`
    );
  }

  return {
    ...sheet,
    reviewer: actor,
    reviewerSignature: { actor, signedAt, checklist: signed },
    status: 'completed',
    completedAt: signedAt,
    revision: sheet.revision + 1
  };
}
