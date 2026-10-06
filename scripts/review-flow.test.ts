// 双人复核流程规则测试（纯逻辑，不涉及 DOM/localStorage）
// 运行：npx tsx scripts/review-flow.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CaseVersion,
  EvidenceItem,
  InvestigationTask,
  ReviewSheet,
  SignalCase
} from '../src/lib/models/signal';
import {
  activeSheet,
  applySignature,
  basisStillValid,
  buildReviewSheet,
  evidenceBasisFingerprint,
  openTasks,
  ReviewError
} from '../src/lib/services/review';

const iso = (minutes: number) => new Date(Date.UTC(2026, 8, 28, 12, minutes)).toISOString();

function makeSignal(overrides: Partial<SignalCase> = {}): SignalCase {
  const tasks: InvestigationTask[] = overrides.tasks ?? [
    { id: 'T1', title: '任务一', owner: '赵珂', dueAt: '2026-10-03', status: 'open' }
  ];
  const evidence: EvidenceItem[] = overrides.evidence ?? [
    {
      id: 'E1',
      type: 'test',
      title: '测试证据一',
      source: '实验室',
      strength: 'strong',
      batch: 'B1',
      note: '支持结论',
      createdAt: iso(0)
    }
  ];
  const versions: CaseVersion[] = overrides.versions ?? [
    {
      id: 'V1',
      version: 1,
      author: '处置人甲',
      summary: '初判存在批次性风险，需要处置',
      disposition: 'corrective_action',
      rationale: '证据充分',
      createdAt: iso(1)
    }
  ];
  return {
    id: 'SIG-T-001',
    title: '测试信号标题',
    product: '产品 P',
    batch: 'B1',
    sourceType: 'test' as SignalCase['sourceType'],
    status: 'investigating',
    riskLevel: 'critical',
    severity: 5,
    reportCount: 1,
    exposedUnits: 1,
    occurrenceRate: 1,
    occurredAt: '2026-09-21',
    openedAt: iso(-10),
    updatedAt: iso(2),
    owner: '处置人甲',
    description: '测试用信号描述，足够长。',
    affectedBatches: ['B1'],
    evidence,
    tasks,
    versions,
    reviewSheets: [],
    audit: [],
    reopenedCount: 0,
    ...overrides
  };
}

function request(signal: SignalCase, purpose: 'action_required' | 'closed' = 'action_required') {
  return buildReviewSheet({
    id: 'RVW-1',
    purpose,
    fromStatus: signal.status,
    signal,
    basisVersionId: signal.versions[0].id,
    handler: '处置人甲',
    createdAt: iso(3)
  });
}

test('处置人不能批准自己的复核（同账号签署被拒绝）', () => {
  const signal = makeSignal();
  const sheet = request(signal);
  assert.throws(
    () =>
      applySignature({
        sheet,
        actor: '处置人甲',
        expectedRevision: 0,
        signal,
        checklist: { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true },
        signedAt: iso(4)
      }),
    /独立于处置人/
  );
});

test('复核人必须逐项确认三项后才能签署', () => {
  const signal = makeSignal();
  const sheet = request(signal);
  assert.throws(
    () =>
      applySignature({
        sheet,
        actor: '复核人乙',
        expectedRevision: 0,
        signal,
        checklist: { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: false },
        signedAt: iso(4)
      }),
    /逐项确认/
  );
});

test('关闭复核存在未完成任务时拒绝签署', () => {
  const signal = makeSignal();
  const sheet = request(signal, 'closed');
  assert.equal(openTasks(signal.tasks).length, 1);
  assert.throws(
    () =>
      applySignature({
        sheet,
        actor: '复核人乙',
        expectedRevision: 0,
        signal,
        checklist: { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true },
        signedAt: iso(4)
      }),
    /未完成调查任务/
  );
});

test('独立复核人逐项确认后签署成功，复核单完成并产生修订号', () => {
  const signal = makeSignal({ tasks: [{ id: 'T1', title: '任务一', owner: '赵珂', dueAt: '2026-10-03', status: 'done' }] });
  const sheet = request(signal, 'closed');
  const signed = applySignature({
    sheet,
    actor: '复核人乙',
    expectedRevision: 0,
    signal,
    checklist: { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true },
    signedAt: iso(4)
  });
  assert.equal(signed.status, 'completed');
  assert.equal(signed.reviewerSignature?.actor, '复核人乙');
  assert.equal(signed.handlerSignature.actor, '处置人甲');
  assert.equal(signed.revision, 1);
  assert.deepEqual(signed.reviewerSignature?.checklist, {
    versionConfirmed: true,
    batchesConfirmed: true,
    tasksConfirmed: true
  });
});

test('两个窗口同时签署：revision 不一致者判为后到一方并冲突', () => {
  const signal = makeSignal();
  const sheetA = request(signal); // 窗口 A 看到 revision 0
  const sheetB = structuredClone(sheetA); // 窗口 B 也看到 revision 0

  // 先到的 A 生效，revision 变为 1
  const afterA = applySignature({
    sheet: sheetA,
    actor: '复核人乙',
    expectedRevision: 0,
    signal,
    checklist: { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true },
    signedAt: iso(4)
  });
  assert.equal(afterA.status, 'completed');

  // 后到的 B 仍提交 expectedRevision=0：冲突，且不会产生第二份有效签署
  assert.throws(
    () =>
      applySignature({
        sheet: afterA,
        actor: '复核人丙',
        expectedRevision: 0,
        signal,
        checklist: { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true },
        signedAt: iso(5)
      }),
    (error: unknown) => error instanceof ReviewError && error.conflict === true
  );
  assert.equal(afterA.reviewerSignature?.actor, '复核人乙');
});

test('失败后重签不能产生第二份有效签署：已完成复核单再次签署被拒绝', () => {
  const signal = makeSignal();
  let sheet = request(signal);
  // 第一次因为漏勾选项失败
  assert.throws(
    () =>
      applySignature({
        sheet,
        actor: '复核人乙',
        expectedRevision: 0,
        signal,
        checklist: { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: false },
        signedAt: iso(4)
      }),
    /逐项确认/
  );
  // 失败不应改变复核单（无第二份签署产生）
  assert.equal(sheet.status, 'pending');
  assert.equal(sheet.reviewerSignature, null);

  // 补齐勾选项后重签成功
  sheet = applySignature({
    sheet,
    actor: '复核人乙',
    expectedRevision: 0,
    signal,
    checklist: { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true },
    signedAt: iso(5)
  });
  assert.equal(sheet.status, 'completed');

  // 再次签署（任何账号）都被拒绝
  assert.throws(
    () =>
      applySignature({
        sheet,
        actor: '复核人丁',
        expectedRevision: 1,
        signal,
        checklist: { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true },
        signedAt: iso(6)
      }),
    /不能产生第二份签署|已失效或已完成/
  );
});

test('证据变化时依据指纹不一致，签署被拒绝', () => {
  const signal = makeSignal();
  const sheet = request(signal);
  signal.evidence.unshift({
    id: 'E2',
    type: 'complaint',
    title: '新到投诉证据',
    source: '客服',
    strength: 'strong',
    batch: 'B1',
    note: '复核期间新增',
    createdAt: iso(6)
  });
  assert.equal(basisStillValid(signal, sheet), false);
  assert.throws(
    () =>
      applySignature({
        sheet,
        actor: '复核人乙',
        expectedRevision: 0,
        signal,
        checklist: { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true },
        signedAt: iso(7)
      }),
    /依据失效/
  );
});

test('形成新结论版本时，旧依据失效', () => {
  const signal = makeSignal();
  const sheet = request(signal);
  signal.versions.unshift({
    id: 'V2',
    version: 2,
    author: '处置人甲',
    summary: '修订后的结论版本',
    disposition: 'risk_communication',
    rationale: '补充证据后的判断',
    createdAt: iso(8)
  });
  assert.notEqual(
    evidenceBasisFingerprint(signal.evidence, signal.versions),
    sheet.basisFingerprint
  );
  assert.throws(
    () =>
      applySignature({
        sheet,
        actor: '复核人乙',
        expectedRevision: 0,
        signal,
        checklist: { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true },
        signedAt: iso(9)
      }),
    /结论版本已更新|依据失效/
  );
});

test('复核单锁定依据快照：版本、批号与未完成任务数量被记录', () => {
  const signal = makeSignal();
  const sheet: ReviewSheet = request(signal);
  assert.equal(sheet.basisVersionId, 'V1');
  assert.deepEqual(sheet.basisBatches, ['B1']);
  assert.equal(sheet.basisOpenTasks.length, 1);
  assert.equal(sheet.handlerSignature.actor, '处置人甲');
  assert.equal(sheet.status, 'pending');
  assert.equal(activeSheet(signal) === undefined, true);
});
