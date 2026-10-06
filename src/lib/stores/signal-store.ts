import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceItem,
  InvestigationTask,
  ReviewRole,
  ReviewSheet,
  ReviewSignature,
  ReviewTarget,
  SignalCase,
  SignalStatus,
  RiskLevel
} from '$lib/models/signal';
import { isHighSeverity } from '$lib/models/signal';
import { seedSignals } from '$lib/services/seed';
import { get, writable } from 'svelte/store';

// v2：引入双人复核单结构，旧本地数据不做迁移
const STORAGE_KEY = 'medical-safety-signals-v2';
const TOKEN_KEY = 'medical-safety-signals-v2-token';

function cloneSeed(): SignalCase[] {
  return structuredClone(seedSignals);
}

function readPersisted(): SignalCase[] {
  if (!browser) return cloneSeed();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SignalCase[]) : cloneSeed();
  } catch {
    return cloneSeed();
  }
}

const internal = writable<SignalCase[]>(readPersisted());

// 当前窗口可见的全局数据版本；localStorage 被其他窗口写入时随之推进
let currentToken = browser ? localStorage.getItem(TOKEN_KEY) ?? 'seed' : 'seed';

if (browser) {
  // 其他窗口先写入后，本窗口同步到最新数据并刷新版本令牌
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY && event.newValue) {
      try {
        internal.set(JSON.parse(event.newValue) as SignalCase[]);
      } catch {
        // 解析失败时保留当前内存数据
      }
    }
    if (event.key === TOKEN_KEY) {
      currentToken = event.newValue ?? 'seed';
    }
  });
}

/** 写操作统一结果，冲突时携带可读原因供界面提示 */
export interface MutationResult {
  ok: boolean;
  error?: string;
  token?: string;
  sheetId?: string;
}

function now() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function samePerson(a: string, b: string) {
  return a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'accent' }) === 0;
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

export function targetLabel(target: ReviewTarget) {
  return target === 'action_required' ? '待处置' : '关闭信号';
}

function appendAudit(signal: SignalCase, actor: string, action: string, detail: string) {
  signal.audit.unshift({
    id: makeId('AUD'),
    actor,
    action,
    detail,
    createdAt: now()
  });
  signal.updatedAt = now();
}

/**
 * 以内存中的最新快照执行变更并落盘。
 * token 不匹配说明另一个窗口已先写入（先到者生效），本窗口放弃写入并报告冲突。
 */
function commit(mutator: (items: SignalCase[]) => { items: SignalCase[]; error?: string }, expectedToken?: string): MutationResult {
  if (!browser) {
    let mutationError: string | undefined;
    internal.update((items) => {
      const result = mutator(structuredClone(items));
      mutationError = result.error;
      return result.error ? items : result.items;
    });
    return mutationError ? { ok: false, error: mutationError } : { ok: true, token: currentToken };
  }

  if (expectedToken !== undefined && expectedToken !== currentToken) {
    return {
      ok: false,
      error: '另一个窗口已先完成操作，您看到的页面已过期。请刷新后基于最新复核单重试，本次签署未生效。',
      token: currentToken
    };
  }

  const snapshot = get(internal);
  const result = mutator(structuredClone(snapshot));
  if (result.error) return { ok: false, error: result.error, token: currentToken };

  // 写入前再次核对令牌，避免两个窗口在同一事件循环内竞争
  const latestToken = localStorage.getItem(TOKEN_KEY) ?? 'seed';
  if (expectedToken !== undefined && expectedToken !== latestToken) {
    internal.set(readPersisted());
    currentToken = latestToken;
    return {
      ok: false,
      error: '检测到并发写入：另一窗口已先签署，本窗口签署冲突失效。请刷新复核单后再操作，不会产生第二份有效签署。',
      token: latestToken
    };
  }

  const nextToken = `${Date.now().toString(36)}-${makeId('t').slice(-8)}`;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(result.items));
  localStorage.setItem(TOKEN_KEY, nextToken);
  currentToken = nextToken;
  internal.set(result.items);
  return { ok: true, token: nextToken };
}

function openTasks(signal: SignalCase): InvestigationTask[] {
  return signal.tasks.filter((task) => task.status !== 'done');
}

function evidenceFingerprint(signal: SignalCase): string {
  return JSON.stringify(
    signal.evidence.map((item) => [item.id, item.title, item.strength, item.batch, item.source, item.note])
  );
}

/** 关联批号口径：信号受影响批号并上证据矩阵中出现的全部批号 */
function relatedBatches(signal: SignalCase): string[] {
  return [...new Set([...signal.affectedBatches, ...signal.evidence.map((item) => item.batch)])];
}

export function activeReviewSheet(signal: SignalCase): ReviewSheet | undefined {
  return signal.reviewSheets.find((sheet) => sheet.status === 'pending');
}

/** 复核单快照与当前证据/版本/批号是否仍一致 */
function sheetIsStale(signal: SignalCase, sheet: ReviewSheet): boolean {
  if (evidenceFingerprint(signal) !== sheet.evidenceFingerprint) return true;
  if (!signal.versions.some((version) => version.id === sheet.versionId)) return true;
  if (relatedBatches(signal).sort().join('|') !== [...sheet.batchSnapshot].sort().join('|')) return true;
  return false;
}

function buildSignature(
  role: ReviewRole,
  actor: string,
  revision: number,
  checklist: ReviewSignature['checklist']
): ReviewSignature {
  return { role, actor, checklist, signedAt: now(), signedRevision: revision };
}

/**
 * 证据、结论版本或调查任务变化后，让未关闭复核单上的原签署失效：
 * - pending：复核单整单作废；若信号在待处置，退回复核
 * - countersigned + 目标待处置：签署失效并退回复核（已关闭记录保持可读、不可变）
 */
function invalidateSheets(
  signal: SignalCase,
  reason: string,
  actor: string,
  options: { revokeCountersignedAction: boolean } = { revokeCountersignedAction: true }
) {
  let changed = false;
  for (const sheet of signal.reviewSheets) {
    if (sheet.status === 'pending') {
      sheet.status = 'invalidated';
      sheet.invalidatedAt = now();
      sheet.invalidatedReason = reason;
      sheet.revision += 1;
      changed = true;
      appendAudit(signal, actor, '复核单失效', `复核单 ${sheet.id}：${reason}，须退回复核重新签署。`);
      if (signal.status === 'review') {
        // 已在复核中则维持
      } else if (signal.status === 'action_required') {
        signal.status = 'review';
        appendAudit(signal, actor, '退回复核', `${reason}，原会签依据失效。`);
      }
    } else if (
      options.revokeCountersignedAction &&
      sheet.status === 'countersigned' &&
      sheet.target === 'action_required'
    ) {
      sheet.status = 'invalidated';
      sheet.invalidatedAt = now();
      sheet.invalidatedReason = reason;
      sheet.revision += 1;
      changed = true;
      appendAudit(
        signal,
        actor,
        '原签署失效',
        `进入待处置的复核单 ${sheet.id} 因${reason}失效，已退回复核；已关闭记录不受影响。`
      );
      if (signal.status === 'action_required') {
        signal.status = 'review';
        appendAudit(signal, actor, '退回复核', `${reason}，须重新双人会签。`);
      }
    }
  }
  return changed;
}

export interface RequestReviewInput {
  id: string;
  target: ReviewTarget;
  handler: string;
  reason: string;
  versionId: string;
  token?: string;
}

export interface SignReviewInput {
  id: string;
  sheetId: string;
  role: ReviewRole;
  actor: string;
  baseRevision: number;
  token?: string;
  confirmsVersion: boolean;
  confirmsBatches: boolean;
  confirmedTaskIds: string[];
}

export const signalStore = {
  subscribe: internal.subscribe,

  getToken() {
    return currentToken;
  },

  add(signal: SignalCase) {
    const result = commit((items) => ({ items: [signal, ...items] }));
    return result;
  },

  create(input: Omit<SignalCase, 'id' | 'openedAt' | 'updatedAt' | 'audit' | 'reopenedCount' | 'reviewSheets'>) {
    const createdAt = now();
    const signal: SignalCase = {
      ...input,
      id: `SIG-${new Date().getFullYear()}-${String(get(internal).length + 20).padStart(3, '0')}`,
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
    this.add(signal);
    return signal;
  },

  /** 处置人发起复核：生成待签复核单并完成处置人签署，信号进入复核中 */
  requestReview(input: RequestReviewInput): MutationResult {
    return commit((items) => {
      const signal = items.find((item) => item.id === input.id);
      if (!signal) return { items, error: '未找到该信号。' };
      if (signal.status === 'closed') return { items, error: '信号已关闭，不能再发起复核；如收到新事件请先重新打开。' };
      if (!isHighSeverity(signal)) return { items, error: '仅高及严重风险信号需要双人会签。' };
      if (activeReviewSheet(signal)) {
        return { items, error: '已有待签复核单，须完成本次双人会签或由变更使其失效后再发起。' };
      }
      const version = signal.versions.find((item) => item.id === input.versionId);
      if (!version) return { items, error: '复核单必须绑定一份现存结论版本，请先形成结论版本。' };

      const open = openTasks(signal);
      const sheet: ReviewSheet = {
        id: makeId('RVW'),
        target: input.target,
        reason: input.reason,
        status: 'pending',
        revision: 0,
        versionId: version.id,
        batchSnapshot: relatedBatches(signal),
        openTaskSnapshot: open.map((task) => ({
          id: task.id,
          title: task.title,
          owner: task.owner,
          dueAt: task.dueAt
        })),
        evidenceFingerprint: evidenceFingerprint(signal),
        openedBy: input.handler,
        openedAt: now(),
        handlerSignature: null,
        reviewerSignature: null,
        countersignedAt: null,
        invalidatedAt: null,
        invalidatedReason: null
      };

      const checklist: ReviewSignature['checklist'] = {
        confirmsVersion: true,
        confirmsBatches: true,
        confirmedTaskIds: open.map((task) => task.id)
      };
      sheet.handlerSignature = buildSignature('handler', input.handler, sheet.revision, checklist);

      const previous = signal.status;
      signal.status = 'review';
      signal.reviewSheets.unshift(sheet);
      appendAudit(
        signal,
        input.handler,
        '发起复核',
        `生成待签复核单 ${sheet.id}（目标：${targetLabel(input.target)}，绑定 V${version.version}），处置人已签署，等待独立复核人逐项确认。`
      );
      if (previous !== 'review') {
        appendAudit(signal, input.handler, '状态流转', `${statusLabel(previous)} -> 复核中；依据：${input.reason}`);
      }
      return { items };
    }, input.token);
  },

  /** 处置人或复核人在复核单上签署；处置人不能批准自己的复核 */
  signReview(input: SignReviewInput): MutationResult {
    return commit((items) => {
      const signal = items.find((item) => item.id === input.id);
      if (!signal) return { items, error: '未找到该信号。' };

      const sheet = signal.reviewSheets.find((item) => item.id === input.sheetId);
      if (!sheet) return { items, error: '复核单不存在，可能已被变更作废。' };
      if (sheet.status !== 'pending') {
        return {
          items,
          error: sheet.status === 'invalidated'
            ? '该复核单已因证据、结论版本或调查任务变化失效，请基于新内容重新发起复核。'
            : '该复核单已完成会签，重复签署不会产生第二份有效签署。'
        };
      }
      if (input.baseRevision !== sheet.revision) {
        return {
          items,
          error: `复核单已被更新（当前修订号 ${sheet.revision}），您提交的是修订号 ${input.baseRevision}。请刷新后重签，本次签署未生效。`
        };
      }

      const otherSignature =
        input.role === 'handler' ? sheet.reviewerSignature : sheet.handlerSignature;
      if (otherSignature && samePerson(otherSignature.actor, input.actor)) {
        return {
          items,
          error:
            input.role === 'reviewer'
              ? '复核人必须独立于处置人：处置人不能批准自己的复核，请由另一名复核人签署。'
              : '处置人不能与复核人为同一账号，请更换处置人签署。'
        };
      }

      // 逐项确认：结论版本、关联批号必须勾选
      if (!input.confirmsVersion || !input.confirmsBatches) {
        return { items, error: '请逐项确认结论版本与关联批号后再签署。' };
      }
      const requiredTaskIds = sheet.openTaskSnapshot.map((task) => task.id);
      const allTasksConfirmed =
        requiredTaskIds.length === 0 ||
        requiredTaskIds.every((taskId) => input.confirmedTaskIds.includes(taskId));
      if (!allTasksConfirmed) {
        return { items, error: '复核人须逐项确认全部未完成调查任务的处置安排后再签署。' };
      }

      if (input.role === 'handler') {
        if (sheet.handlerSignature) {
          return { items, error: '处置人签署槽位已有有效签署，重复提交不会产生第二份签署。' };
        }
        sheet.handlerSignature = buildSignature(
          'handler',
          input.actor,
          sheet.revision,
          {
            confirmsVersion: input.confirmsVersion,
            confirmsBatches: input.confirmsBatches,
            confirmedTaskIds: input.confirmedTaskIds
          }
        );
        sheet.revision += 1;
        appendAudit(
          signal,
          input.actor,
          '处置人签署',
          `复核单 ${sheet.id} 处置人已签署，等待独立复核人逐项确认结论版本 V${signal.versions.find((v) => v.id === sheet.versionId)?.version ?? '?'}、批号与未完成任务。`
        );
        return { items };
      }

      // 复核人签署前，处置人必须已签署；并再次核对快照未漂移
      if (!sheet.handlerSignature) {
        return { items, error: '处置人尚未签署，复核人不能先于处置人签署。' };
      }
      if (sheetIsStale(signal, sheet)) {
        invalidateSheets(signal, '签署时发现证据、结论版本或批号已变化', input.actor, {
          revokeCountersignedAction: false
        });
        return { items, error: '签署时发现复核单依据已变化，原签署失效并退回复核，请重新发起。' };
      }
      if (sheet.reviewerSignature) {
        return { items, error: '复核人签署槽位已有有效签署，重复提交不会产生第二份签署。' };
      }

      sheet.reviewerSignature = buildSignature('reviewer', input.actor, sheet.revision, {
        confirmsVersion: input.confirmsVersion,
        confirmsBatches: input.confirmsBatches,
        confirmedTaskIds: input.confirmedTaskIds
      });
      sheet.status = 'countersigned';
      sheet.countersignedAt = now();
      sheet.revision += 1;

      appendAudit(
        signal,
        input.actor,
        '复核人会签',
        `复核单 ${sheet.id} 经独立复核人逐项确认结论版本、关联批号与 ${requiredTaskIds.length} 项未完成任务后完成会签。`
      );

      const previous = signal.status;
      signal.status = sheet.target;
      appendAudit(
        signal,
        input.actor,
        '状态流转',
        `双人会签完成：${statusLabel(previous)} -> ${statusLabel(sheet.target)}；依据复核单 ${sheet.id}。`
      );
      return { items };
    }, input.token);
  },

  transition(id: string, nextStatus: SignalStatus, reason: string, actor: string) {
    return commit((items) => {
      const signal = items.find((item) => item.id === id);
      if (!signal) return { items, error: '未找到该信号。' };
      if (signal.status === 'closed') {
        return { items, error: '信号已关闭且记录只读；收到新事件请使用“重新打开”。' };
      }
      if (nextStatus === signal.status) {
        return { items, error: `信号已处于「${statusLabel(nextStatus)}」，无需重复流转。` };
      }
      if (activeReviewSheet(signal)) {
        return { items, error: '存在待签复核单：高严重度信号须完成双人会签后才能流转。' };
      }
      if (isHighSeverity(signal) && (nextStatus === 'action_required' || nextStatus === 'closed')) {
        return {
          items,
          error: `高及严重风险信号进入「${statusLabel(nextStatus)}」前必须完成双人会签，请先生成待签复核单。`
        };
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
      return { items };
    });
  },

  addEvidence(id: string, evidence: EvidenceItem, actor: string): MutationResult {
    return commit((items) => {
      const signal = items.find((item) => item.id === id);
      if (!signal) return { items, error: '未找到该信号。' };
      if (signal.status === 'closed') {
        return { items, error: '信号已关闭，证据矩阵保持只读；如需补充证据请先重新打开。' };
      }
      signal.evidence.unshift(evidence);
      appendAudit(
        signal,
        actor,
        '新增证据',
        `${evidence.title}，证据强度：${evidence.strength}`
      );
      invalidateSheets(signal, `证据发生变化（新增：${evidence.title}）`, actor);
      return { items };
    });
  },

  addVersion(id: string, version: CaseVersion, actor: string): MutationResult {
    return commit((items) => {
      const signal = items.find((item) => item.id === id);
      if (!signal) return { items, error: '未找到该信号。' };
      if (signal.status === 'closed') {
        return { items, error: '信号已关闭，结论版本保持只读；如需形成新版本请先重新打开。' };
      }
      signal.versions.unshift(version);
      appendAudit(signal, actor, '形成版本', `版本 V${version.version}：${version.summary}`);
      invalidateSheets(signal, `结论版本发生变化（新增 V${version.version}）`, actor);
      return { items };
    });
  },

  replaceTask(id: string, task: InvestigationTask, token?: string): MutationResult {
    return commit((items) => {
      const signal = items.find((item) => item.id === id);
      if (!signal) return { items, error: '未找到该信号。' };
      if (signal.status === 'closed') {
        return { items, error: '信号已关闭，调查任务保持只读。' };
      }
      const previous = signal.tasks.find((item) => item.id === task.id);
      if (!previous) return { items, error: '调查任务不存在。' };
      signal.tasks = signal.tasks.map((item) => (item.id === task.id ? task : item));
      appendAudit(signal, task.owner, '更新任务', `${task.title}：${previous.status} -> ${task.status}`);
      invalidateSheets(signal, `调查任务发生变化（${task.title}：${task.status}）`, task.owner);
      return { items };
    }, token);
  },

  reopen(id: string, actor: string, reason: string): MutationResult {
    return commit((items) => {
      const signal = items.find((item) => item.id === id);
      if (!signal) return { items, error: '未找到该信号。' };
      if (signal.status !== 'closed') return { items, error: '只有已关闭信号才能重新打开。' };
      signal.status = 'investigating';
      signal.reopenedCount += 1;
      appendAudit(signal, actor, '重新打开', reason);
      appendAudit(
        signal,
        actor,
        '历史会签保留',
        '关闭时的复核单与审计记录保持可读，新的处置须重新发起双人会签。'
      );
      return { items };
    });
  },

  addAudit(id: string, entry: AuditEntry) {
    commit((items) => {
      const signal = items.find((item) => item.id === id);
      if (!signal) return { items };
      signal.audit.unshift(entry);
      signal.updatedAt = entry.createdAt;
      return { items };
    });
  },

  reset() {
    if (browser) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(TOKEN_KEY);
      currentToken = 'seed';
    }
    internal.set(cloneSeed());
  },

  getSnapshot() {
    return get(internal);
  },

  /** 测试/跨窗口重连用：丢弃内存态并从持久层重新装载 */
  __hydrateFromStorage() {
    if (!browser) return;
    internal.set(readPersisted());
    currentToken = localStorage.getItem(TOKEN_KEY) ?? 'seed';
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
