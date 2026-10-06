import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceItem,
  InvestigationTask,
  ReviewChecklist,
  ReviewPurpose,
  ReviewSheet,
  SignalCase,
  SignalStatus,
  RiskLevel
} from '$lib/models/signal';
import { seedSignals } from '$lib/services/seed';
import {
  activeSheet,
  applySignature,
  basisStillValid,
  buildReviewSheet,
  evidenceBasisFingerprint,
  openTasks,
  requiresDualReview,
  ReviewError,
  reviewPurposeLabels,
  type StoreResult
} from '$lib/services/review';
import { get, writable } from 'svelte/store';

const STORAGE_KEY = 'medical-safety-signals-v2';

function cloneSeed(): SignalCase[] {
  return structuredClone(seedSignals);
}

/** 兼容旧版本台账：补齐复核单数组 */
function migrate(raw: Partial<SignalCase>[]): SignalCase[] {
  return raw.map((signal) => ({
    reviewSheets: [],
    ...signal
  })) as SignalCase[];
}

function readPersisted(): SignalCase[] {
  if (!browser) return cloneSeed();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw) as Partial<SignalCase>[]);
    // 旧版本键存在时做一次迁移，避免已登记数据丢失
    const legacy = localStorage.getItem('medical-safety-signals-v1');
    return legacy ? migrate(JSON.parse(legacy) as Partial<SignalCase>[]) : cloneSeed();
  } catch {
    return cloneSeed();
  }
}

const internal = writable<SignalCase[]>(readPersisted());

if (browser) {
  internal.subscribe((value) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  });
  // 其他窗口（如第二个签署窗口）提交后，本窗口实时拿到最新台账
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      internal.set(migrate(JSON.parse(event.newValue) as Partial<SignalCase>[]));
    } catch {
      // 忽略无法解析的外部写入
    }
  });
}

function now() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

function statusLabel(status: SignalStatus) {
  const labels: Record<SignalStatus, string> = {
    new: '待分派',
    investigating: '调查中',
    observed: '持续观察',
    action_required: '待处置',
    review: '复核中',
    closed: '已关闭'
  };
  return labels[status];
}

function appendAudit(signal: SignalCase, actor: string, action: string, detail: string) {
  const timestamp = now();
  signal.audit.unshift({
    id: makeId('AUD'),
    actor,
    action,
    detail,
    createdAt: timestamp
  });
  signal.updatedAt = timestamp;
}

function failure(error: unknown): StoreResult<never> {
  if (error instanceof ReviewError) {
    return { ok: false, message: error.message, conflict: error.conflict };
  }
  return { ok: false, message: error instanceof Error ? error.message : '操作被拒绝。' };
}

let memoryLockChain: Promise<unknown> = Promise.resolve();

/**
 * 跨标签页互斥：保证“读最新台账 → 修改 → 写回”原子执行，
 * 两个签署窗口同时提交时串行化，再由复核单 revision 判定先到/后到。
 */
function withLock<T>(task: () => T | Promise<T>): Promise<T> {
  const run = (): Promise<T> => {
    const result = task();
    return result instanceof Promise ? result : Promise.resolve(result);
  };
  if (browser && typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
    return navigator.locks.request('medical-safety-signals', run) as Promise<T>;
  }
  // SSR 或不支持 Web Locks 的环境：用进程内 Promise 链串行化
  const result = memoryLockChain.then(run, run);
  memoryLockChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * 以 localStorage 中的最新台账为基准施加变更。
 * 两个窗口同时提交时，后提交者在锁内读到的是先提交者写入后的状态，
 * 再由复核单 revision 乐观锁判定冲突，保证只有先到一方生效。
 */
function commit<T = void>(
  id: string,
  mutate: (signal: SignalCase) => T
): Promise<StoreResult<T>> {
  return withLock(() => {
    const latest = readLatest();
    const index = latest.findIndex((signal) => signal.id === id);
    if (index === -1) {
      return { ok: false as const, message: '未找到该信号案例。' };
    }
    const working = structuredClone(latest[index]);
    let data: T;
    try {
      data = mutate(working);
    } catch (error) {
      return failure(error);
    }
    const next = [...latest];
    next[index] = working;
    internal.set(next);
    return { ok: true as const, data };
  });
}

function readLatest(): SignalCase[] {
  if (!browser) return get(internal);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw) as Partial<SignalCase>[]);
  } catch {
    // 落到内存态
  }
  return get(internal);
}

function assertNotClosed(signal: SignalCase) {
  if (signal.status === 'closed') {
    throw new ReviewError('信号已关闭，记录保持只读；如有新事件请先重新打开。');
  }
}

/** 作废待签复核单并退回复核中；可选作废已完成的“待处置”复核单 */
function invalidateSheets(
  signal: SignalCase,
  reason: string,
  options: { includeCompletedAction?: boolean } = {}
): boolean {
  let invalidated = false;
  for (const sheet of signal.reviewSheets) {
    if (sheet.status !== 'pending') {
      if (
        options.includeCompletedAction &&
        sheet.status === 'completed' &&
        sheet.purpose === 'action_required'
      ) {
        sheet.status = 'voided';
        sheet.voidedReason = reason;
        sheet.revision += 1;
        invalidated = true;
      }
      continue;
    }
    sheet.status = 'voided';
    sheet.voidedReason = reason;
    sheet.revision += 1;
    invalidated = true;
  }
  if (invalidated && signal.status !== 'review' && signal.status !== 'closed') {
    signal.status = 'review';
  }
  return invalidated;
}

export const signalStore = {
  subscribe: internal.subscribe,

  add(signal: SignalCase): Promise<void> {
    return withLock(() => {
      internal.set([structuredClone(signal), ...readLatest()]);
    });
  },

  create(
    input: Omit<
      SignalCase,
      'id' | 'openedAt' | 'updatedAt' | 'audit' | 'reopenedCount' | 'reviewSheets'
    >
  ): Promise<SignalCase> {
    return withLock(() => {
      const createdAt = now();
      const signal: SignalCase = {
        ...input,
        id: `SIG-${new Date().getFullYear()}-${String(readLatest().length + 20).padStart(3, '0')}`,
        openedAt: createdAt,
        updatedAt: createdAt,
        reopenedCount: 0,
        reviewSheets: [],
        audit: [
          {
            id: makeId('AUD'),
            actor: input.owner,
            action: '建立信号',
            detail: `按${input.sourceType}来源建立核查任务。`,
            createdAt
          }
        ]
      };
      internal.set([signal, ...readLatest()]);
      return signal;
    });
  },

  transition(
    id: string,
    nextStatus: SignalStatus,
    reason: string,
    actor: string
  ): Promise<StoreResult> {
    return commit(id, (signal) => {
      assertNotClosed(signal);
      // 高及以上风险：进入待处置/关闭必须走双人复核单，不允许单账号直接流转
      if (
        requiresDualReview(signal.riskLevel) &&
        (nextStatus === 'action_required' || nextStatus === 'closed')
      ) {
        throw new ReviewError(
          '高及以上风险信号必须先发起双人复核单，由处置人与独立复核人先后签署后才能进入该状态。'
        );
      }
      const pending = activeSheet(signal);
      if (pending && nextStatus !== 'review') {
        pending.status = 'voided';
        pending.voidedReason = `处置人发起状态流转（${statusLabel(nextStatus)}），复核终止。`;
        pending.revision += 1;
        appendAudit(
          signal,
          actor,
          '复核单失效',
          `复核单 ${pending.id} 因状态流转至${statusLabel(nextStatus)}而作废。`
        );
      }
      const previous = signal.status;
      signal.status = nextStatus;
      if (nextStatus === 'action_required' && signal.riskLevel === 'low') {
        signal.riskLevel = 'medium';
      }
      appendAudit(
        signal,
        actor,
        '状态流转',
        `${statusLabel(previous)} -> ${statusLabel(nextStatus)}；依据：${reason}`
      );
    });
  },

  addEvidence(id: string, evidence: EvidenceItem, actor: string): Promise<StoreResult> {
    return commit(id, (signal) => {
      assertNotClosed(signal);
      signal.evidence.unshift(evidence);
      appendAudit(
        signal,
        actor,
        '新增证据',
        `${evidence.title}，证据强度：${evidence.strength}`
      );
      // 证据变化：待签复核单失效退回；已进入待处置的，完成单同样失效并退回复核
      const reason = `证据矩阵发生变化（新增：${evidence.title}）`;
      const invalidated = invalidateSheets(signal, reason, { includeCompletedAction: true });
      if (invalidated) {
        appendAudit(
          signal,
          '系统',
          '复核单失效',
          `${reason}，原签署不再作为依据，须重新发起双人复核。`
        );
      }
    });
  },

  addVersion(id: string, version: CaseVersion, actor: string): Promise<StoreResult> {
    return commit(id, (signal) => {
      assertNotClosed(signal);
      signal.versions.unshift(version);
      appendAudit(signal, actor, '形成版本', `版本 V${version.version}：${version.summary}`);
      // 结论版本变化：复核依据中的版本不再是最新版本，原签署失效
      const reason = `形成新结论版本 V${version.version}`;
      const invalidated = invalidateSheets(signal, reason, { includeCompletedAction: true });
      if (invalidated) {
        appendAudit(
          signal,
          '系统',
          '复核单失效',
          `${reason}，原签署不再作为依据，须重新发起双人复核。`
        );
      }
    });
  },

  /**
   * 发起双人复核：进入待处置或关闭前生成待签复核单，
   * 处置人当场签署（handlerSignature），信号转入“复核中”等待独立复核人。
   */
  requestReview(
    id: string,
    purpose: ReviewPurpose,
    actor: string,
    basisVersionId: string
  ): Promise<StoreResult<{ sheetId: string; revision: number }>> {
    return commit(id, (signal) => {
      assertNotClosed(signal);
      if (!requiresDualReview(signal.riskLevel)) {
        throw new ReviewError('仅高及以上风险信号需要双人复核。');
      }
      if (activeSheet(signal)) {
        throw new ReviewError('已有待签署复核单，请等待复核人签署或由复核人退回后再发起。');
      }
      if (signal.versions.length === 0) {
        throw new ReviewError('尚未形成结论版本，不能发起复核。');
      }
      if (purpose === 'closed' && openTasks(signal.tasks).length > 0) {
        throw new ReviewError('关闭复核要求调查任务全部完成，请先关闭未完成任务。');
      }
      const createdAt = now();
      const sheet = buildReviewSheet({
        id: makeId('RVW'),
        purpose,
        fromStatus: signal.status,
        signal,
        basisVersionId,
        handler: actor,
        createdAt
      });
      signal.reviewSheets.unshift(sheet);
      signal.status = 'review';
      appendAudit(
        signal,
        actor,
        '发起双人复核',
        `复核单 ${sheet.id}（目的：${reviewPurposeLabels[purpose]}）已生成并由处置人签署；` +
          `锁定 ${sheet.basisVersionLabel}；关联批号 ${sheet.basisBatches.join('、') || '无'}；` +
          `未完成调查任务 ${sheet.basisOpenTasks.length} 项。等待独立复核人签署。`
      );
      return { sheetId: sheet.id, revision: sheet.revision };
    });
  },

  /**
   * 独立复核人逐项确认后签署。expectedRevision 与当前不一致即为并发冲突：
   * 另一窗口已先完成签署或依据已变化，拒绝产生第二份有效签署。
   */
  signReview(
    id: string,
    sheetId: string,
    actor: string,
    expectedRevision: number,
    checklist: ReviewChecklist
  ): Promise<StoreResult<{ sheetId: string; status: SignalStatus }>> {
    return commit(id, (signal) => {
      const sheet = signal.reviewSheets.find((item) => item.id === sheetId);
      if (!sheet) throw new ReviewError('复核单不存在。');
      const signedAt = now();
      const updated = applySignature({
        sheet,
        actor,
        expectedRevision,
        signal,
        checklist,
        signedAt
      });
      Object.assign(sheet, updated);

      const confirmedText = [
        checklist.versionConfirmed ? '结论版本' : null,
        checklist.batchesConfirmed ? '关联批号' : null,
        checklist.tasksConfirmed ? '调查任务' : null
      ]
        .filter(Boolean)
        .join('、');
      appendAudit(
        signal,
        actor,
        '复核签署',
        `复核人逐项确认（${confirmedText}）后签署复核单 ${sheet.id}；` +
          `处置人 ${sheet.handlerSignature?.actor}，复核人 ${actor}，双方账号独立。`
      );

      const nextStatus: SignalStatus = sheet.purpose === 'closed' ? 'closed' : 'action_required';
      const previous = signal.status;
      signal.status = nextStatus;
      appendAudit(
        signal,
        actor,
        '状态流转',
        `${statusLabel(previous)} -> ${statusLabel(nextStatus)}；依据：双人复核单 ${sheet.id} 已完成双签。`
      );
      return { sheetId: sheet.id, status: nextStatus };
    });
  },

  /** 登记或更换独立复核人；更换过程留下审计依据 */
  assignReviewer(
    id: string,
    sheetId: string,
    actor: string,
    reviewer: string
  ): Promise<StoreResult> {
    return commit(id, (signal) => {
      const sheet = signal.reviewSheets.find((item) => item.id === sheetId);
      if (!sheet) throw new ReviewError('复核单不存在。');
      if (sheet.status !== 'pending') {
        throw new ReviewError('复核单已结束，不能再更换复核人。');
      }
      if (sheet.handlerSignature && reviewer === sheet.handlerSignature.actor) {
        throw new ReviewError('复核人必须独立于处置人，不能指派处置人本人。');
      }
      if (sheet.reviewerSignature && reviewer === sheet.reviewerSignature.actor) {
        throw new ReviewError('该复核人已完成签署。');
      }
      const previous = sheet.reviewer;
      sheet.reviewer = reviewer;
      sheet.revision += 1;
      appendAudit(
        signal,
        actor,
        previous ? '更换复核人' : '指派复核人',
        previous
          ? `复核单 ${sheet.id} 的复核人由 ${previous} 更换为 ${reviewer}，更换前未产生复核签署。`
          : `复核单 ${sheet.id} 登记独立复核人 ${reviewer}。`
      );
    });
  },

  /** 复核人退回：复核单作废留痕，信号停留在复核中，处置人修正后重新发起 */
  rejectReview(
    id: string,
    sheetId: string,
    actor: string,
    reason: string,
    expectedRevision: number
  ): Promise<StoreResult> {
    return commit(id, (signal) => {
      const sheet = signal.reviewSheets.find((item) => item.id === sheetId);
      if (!sheet) throw new ReviewError('复核单不存在。');
      if (expectedRevision !== sheet.revision) {
        throw new ReviewError(
          `复核单已被其他操作更新（修订 ${expectedRevision} → ${sheet.revision}），请刷新后重试。`,
          true
        );
      }
      if (sheet.status !== 'pending') throw new ReviewError('复核单已结束，不能退回。');
      if (sheet.reviewer && actor !== sheet.reviewer) {
        throw new ReviewError(`只有被指派的复核人 ${sheet.reviewer} 可以退回。`);
      }
      if (sheet.handlerSignature && actor === sheet.handlerSignature.actor) {
        throw new ReviewError('处置人不能以复核人身份退回自己的复核。');
      }
      sheet.status = 'voided';
      sheet.rejectionReason = reason;
      sheet.voidedReason = `复核人退回：${reason}`;
      sheet.reviewer = sheet.reviewer ?? actor;
      sheet.revision += 1;
      signal.status = 'review';
      appendAudit(
        signal,
        actor,
        '复核退回',
        `复核单 ${sheet.id} 被复核人 ${actor} 退回：${reason}。处置人须补充证据或修订结论后重新发起复核。`
      );
    });
  },

  updateTaskStatus(
    id: string,
    taskId: string,
    status: InvestigationTask['status']
  ): Promise<StoreResult> {
    return commit(id, (signal) => {
      assertNotClosed(signal);
      const task = signal.tasks.find((item) => item.id === taskId);
      if (!task) throw new ReviewError('调查任务不存在。');
      const previous = task.status;
      task.status = status;
      appendAudit(signal, task.owner, '更新任务', `${task.title}：${previous} -> ${status}`);
    });
  },

  reopen(id: string, actor: string, reason: string): Promise<StoreResult> {
    return commit(id, (signal) => {
      if (signal.status !== 'closed') {
        throw new ReviewError('只有已关闭信号可以重新打开。');
      }
      const closing = signal.reviewSheets.find(
        (sheet) => sheet.status === 'completed' && sheet.purpose === 'closed'
      );
      if (closing) {
        closing.status = 'voided';
        closing.voidedReason = `信号重新打开：${reason}`;
        closing.revision += 1;
      }
      signal.status = 'investigating';
      signal.reopenedCount += 1;
      appendAudit(signal, actor, '重新打开', reason);
      appendAudit(
        signal,
        '系统',
        '复核单失效',
        '关闭所依据的双人复核单随重新打开而失效；已关闭记录仍可查阅，须重新完成复核才能再次关闭。'
      );
    });
  },

  addAudit(id: string, entry: AuditEntry) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.audit.unshift(entry);
        updated.updatedAt = entry.createdAt;
        return updated;
      })
    );
  },

  reset() {
    if (browser) localStorage.removeItem(STORAGE_KEY);
    internal.set(cloneSeed());
  },

  getSnapshot() {
    return readLatest();
  }
};

export function createSignalFromForm(input: {
  title: string;
  product: string;
  batch: string;
  sourceType: SignalCase['sourceType'];
  severity: number;
  occurredAt: string;
  description: string;
}): SignalCase {
  const nowIso = now();
  return {
    id: `SIG-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`,
    title: input.title,
    product: input.product,
    batch: input.batch,
    sourceType: input.sourceType,
    status: 'new',
    riskLevel: riskFromSeverity(input.severity),
    severity: input.severity,
    reportCount: 1,
    exposedUnits: 0,
    occurrenceRate: 0,
    occurredAt: input.occurredAt,
    openedAt: nowIso,
    updatedAt: nowIso,
    owner: '待分派',
    description: input.description,
    affectedBatches: [input.batch],
    evidence: [],
    tasks: [
      {
        id: makeId('TASK'),
        title: '核对来源记录与产品批号',
        owner: '待分派',
        dueAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
        status: 'open'
      }
    ],
    versions: [],
    reviewSheets: [],
    audit: [
      {
        id: makeId('AUD'),
        actor: '安全台账',
        action: '建立信号',
        detail: '由人工登记表单创建初始信号。',
        createdAt: nowIso
      }
    ],
    reopenedCount: 0
  };
}
