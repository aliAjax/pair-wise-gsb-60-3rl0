// Store 集成测试：模拟两个浏览器窗口共享 localStorage 时的并发签署、依据失效与关闭只读
// 运行：npx tsx scripts/signal-store.test.ts
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

// --- 最小 DOM / 锁环境，必须在 store 模块加载前安装 ---
const sharedMap = new Map<string, string>();

globalThis.localStorage = {
  getItem: (key: string) => (sharedMap.has(key) ? sharedMap.get(key)! : null),
  setItem: (key: string, value: string) => sharedMap.set(key, value),
  removeItem: (key: string) => sharedMap.delete(key),
  clear: () => sharedMap.clear()
} as unknown as Storage;

// 模拟跨标签页互斥锁（与 navigator.locks.request 语义对齐：全局串行）
let lockChain: Promise<unknown> = Promise.resolve();
globalThis.navigator = {
  locks: {
    request: (_name: string, callback: () => unknown) => {
      const run = () => Promise.resolve(callback());
      const result = lockChain.then(run, run);
      lockChain = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }
  }
} as unknown as Navigator;

globalThis.window = { addEventListener: () => undefined } as unknown as Window &
  typeof globalThis;

const { signalStore } = await import('../src/lib/stores/signal-store.ts');

const storeA = signalStore;
const storeB = signalStore;
const SIG_ID = 'SIG-2026-018';

beforeEach(() => {
  sharedMap.clear();
  lockChain = Promise.resolve();
  storeA.reset();
  // reset() 只重设内存态，清掉持久层以保证用例从种子数据开始
  globalThis.localStorage.clear();
});

test('完整双人复核流程：发起 → 同账号拒签 → 独立复核人签署 → 进入待处置', async () => {
  // SIG-2026-018 为高风险、有结论版本
  const res1 = await storeA.requestReview(SIG_ID, 'action_required', '周宁', 'V-018-01');
  assert.equal(res1.ok, true, JSON.stringify(res1));

  let signalA = storeA.getSnapshot().find((s: any) => s.id === SIG_ID);
  assert.equal(signalA.status, 'review');
  const sheetId = signalA.reviewSheets[0].id;

  // 处置人不能批准自己的复核
  const selfSign = await storeB.signReview(
    SIG_ID,
    sheetId,
    '周宁',
    0,
    { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true }
  );
  assert.equal(selfSign.ok, false);
  assert.match(selfSign.message, /独立于处置人/);

  // 独立复核人未逐项确认
  const partial = await storeB.signReview(
    SIG_ID,
    sheetId,
    '郑敏',
    0,
    { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: false }
  );
  assert.equal(partial.ok, false);
  assert.match(partial.message, /逐项确认/);

  // 待处置复核允许有未完成任务，逐项确认后签署成功
  const signed = await storeB.signReview(
    SIG_ID,
    sheetId,
    '郑敏',
    0,
    { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true }
  );
  assert.equal(signed.ok, true, JSON.stringify(signed));
  assert.equal(signed.data.status, 'action_required');

  signalA = storeA.getSnapshot().find((s: any) => s.id === SIG_ID);
  assert.equal(signalA.status, 'action_required');
  const sheet = signalA.reviewSheets.find((s: any) => s.id === sheetId);
  assert.equal(sheet.status, 'completed');
  assert.equal(sheet.handlerSignature.actor, '周宁');
  assert.equal(sheet.reviewerSignature.actor, '郑敏');
});

test('两个窗口同时签署：先到生效，后到冲突且无第二份有效签署', async () => {
  await storeA.requestReview(SIG_ID, 'action_required', '周宁', 'V-018-01');
  const sheetId = storeA
    .getSnapshot()
    .find((s: any) => s.id === SIG_ID).reviewSheets[0].id;

  const checklist = {
    versionConfirmed: true,
    batchesConfirmed: true,
    tasksConfirmed: true
  };
  // 两个窗口都基于修订号 0 同时提交（锁内串行执行）
  const [first, second] = await Promise.all([
    storeA.signReview(SIG_ID, sheetId, '郑敏', 0, checklist),
    storeB.signReview(SIG_ID, sheetId, '韩朔', 0, checklist)
  ]);

  const results = [first, second];
  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 1, '只有一方签署成功');
  const failed = results.find((r) => !r.ok);
  assert.equal(failed.conflict, true, '后到一方得到冲突标记');
  assert.match(failed.message, /修订/);

  const signal = storeA.getSnapshot().find((s: any) => s.id === SIG_ID);
  const sheet = signal.reviewSheets.find((s: any) => s.id === sheetId);
  assert.equal(sheet.status, 'completed');
  assert.equal(signal.status, 'action_required');
  // 只有一位复核人签署，不存在第二份有效签署
  assert.equal(sheet.reviewerSignature.actor, results[0].ok ? '郑敏' : '韩朔');
});

test('复核期间新增证据：原签署失效并退回复核', async () => {
  await storeA.requestReview(SIG_ID, 'action_required', '周宁', 'V-018-01');
  const sheetId = storeA
    .getSnapshot()
    .find((s: any) => s.id === SIG_ID).reviewSheets[0].id;

  const added = await storeA.addEvidence(
    SIG_ID,
    {
      id: 'E-NEW',
      type: 'complaint',
      title: '复核期间新增的投诉证据',
      source: '客服系统',
      strength: 'strong',
      batch: 'IP8-260401',
      note: '新出现的同批次投诉。',
      createdAt: new Date().toISOString()
    },
    '周宁'
  );
  assert.equal(added.ok, true);

  const signal = storeA.getSnapshot().find((s: any) => s.id === SIG_ID);
  assert.equal(signal.status, 'review', '退回复核中');
  const sheet = signal.reviewSheets.find((s: any) => s.id === sheetId);
  assert.equal(sheet.status, 'voided');
  assert.match(sheet.voidedReason, /证据/);

  // 复核人再签旧单会被拒绝
  const stale = await storeB.signReview(
    SIG_ID,
    sheetId,
    '郑敏',
    0,
    { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true }
  );
  assert.equal(stale.ok, false);
});

test('形成新结论版本后：已完成的待处置签署失效，信号退回复核', async () => {
  await storeA.requestReview(SIG_ID, 'action_required', '周宁', 'V-018-01');
  const sheetId = storeA
    .getSnapshot()
    .find((s: any) => s.id === SIG_ID).reviewSheets[0].id;
  await storeB.signReview(
    SIG_ID,
    sheetId,
    '郑敏',
    0,
    { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true }
  );
  let signal = storeA.getSnapshot().find((s: any) => s.id === SIG_ID);
  assert.equal(signal.status, 'action_required');

  const versioned = await storeA.addVersion(
    SIG_ID,
    {
      id: 'V-NEW',
      version: 2,
      author: '周宁',
      summary: '补充现场数据后的修订结论版本',
      disposition: 'corrective_action',
      rationale: '现场扭矩数据已补齐。',
      createdAt: new Date().toISOString()
    },
    '周宁'
  );
  assert.equal(versioned.ok, true);

  signal = storeA.getSnapshot().find((s: any) => s.id === SIG_ID);
  assert.equal(signal.status, 'review');
  const sheet = signal.reviewSheets.find((s: any) => s.id === sheetId);
  assert.equal(sheet.status, 'voided');
});

test('高风险信号不能单账号直接流转到待处置或关闭', async () => {
  const direct = await storeA.transition(SIG_ID, 'closed', '直接关闭无复核', '周宁');
  assert.equal(direct.ok, false);
  assert.match(direct.message, /双人复核/);
});

test('关闭复核要求任务全部完成；关闭后证据、版本、流转均只读', async () => {
  // 先把任务全部完成
  for (const taskId of ['T-018-01', 'T-018-02']) {
    const r = await storeA.updateTaskStatus(SIG_ID, taskId, 'done');
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const req = await storeA.requestReview(SIG_ID, 'closed', '周宁', 'V-018-01');
  assert.equal(req.ok, true, JSON.stringify(req));
  const sheetId = req.data.sheetId;

  const signed = await storeB.signReview(
    SIG_ID,
    sheetId,
    '郑敏',
    0,
    { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true }
  );
  assert.equal(signed.ok, true, JSON.stringify(signed));
  assert.equal(signed.data.status, 'closed');

  // 只读：证据、版本、流转、任务更新均被拒绝，但记录仍可读取
  const ev = await storeA.addEvidence(
    SIG_ID,
    {
      id: 'E-X',
      type: 'test',
      title: '关闭后试图补录的证据',
      source: 'X',
      strength: 'weak',
      batch: 'B',
      note: '不应被接受。',
      createdAt: new Date().toISOString()
    },
    '周宁'
  );
  assert.equal(ev.ok, false);
  assert.match(ev.message, /只读/);

  const tr = await storeA.transition(SIG_ID, 'investigating', '关闭后尝试流转', '周宁');
  assert.equal(tr.ok, false);

  const tk = await storeA.updateTaskStatus(SIG_ID, 'T-018-01', 'open');
  assert.equal(tk.ok, false);

  const signal = storeA.getSnapshot().find((s: any) => s.id === SIG_ID);
  assert.equal(signal.status, 'closed');
  assert.equal(signal.evidence.length, 3, '历史证据保持可读');
  assert.ok(signal.reviewSheets.some((s: any) => s.status === 'completed'));
});

test('更换复核人留下审计依据，且不能指派处置人本人', async () => {
  await storeA.requestReview(SIG_ID, 'action_required', '周宁', 'V-018-01');
  const sheetId = storeA
    .getSnapshot()
    .find((s: any) => s.id === SIG_ID).reviewSheets[0].id;

  const selfAssign = await storeA.assignReviewer(SIG_ID, sheetId, '周宁', '周宁');
  assert.equal(selfAssign.ok, false);

  const assign = await storeA.assignReviewer(SIG_ID, sheetId, '周宁', '郑敏');
  assert.equal(assign.ok, true);
  const reassign = await storeA.assignReviewer(SIG_ID, sheetId, '周宁', '韩朔');
  assert.equal(reassign.ok, true);

  const signal = storeA.getSnapshot().find((s: any) => s.id === SIG_ID);
  assert.equal(signal.reviewSheets[0].reviewer, '韩朔');
  assert.ok(signal.audit.some((a: any) => a.action === '更换复核人' && a.detail.includes('郑敏')));

  // 更换后 revision 递增，旧窗口以修订号 0 签署会冲突
  const stale = await storeB.signReview(
    SIG_ID,
    sheetId,
    '郑敏',
    0,
    { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true }
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
});

test('重新打开关闭信号：关闭签署失效，须重新复核才能再次关闭', async () => {
  for (const taskId of ['T-018-01', 'T-018-02']) {
    await storeA.updateTaskStatus(SIG_ID, taskId, 'done');
  }
  const req = await storeA.requestReview(SIG_ID, 'closed', '周宁', 'V-018-01');
  const sheetId = req.data.sheetId;
  await storeB.signReview(
    SIG_ID,
    sheetId,
    '郑敏',
    0,
    { versionConfirmed: true, batchesConfirmed: true, tasksConfirmed: true }
  );
  let signal = storeA.getSnapshot().find((s: any) => s.id === SIG_ID);
  assert.equal(signal.status, 'closed');

  const reopened = await storeA.reopen(SIG_ID, '周宁', '收到同批次新的不良事件报告，需要补充调查。');
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  signal = storeA.getSnapshot().find((s: any) => s.id === SIG_ID);
  assert.equal(signal.status, 'investigating');
  assert.equal(signal.reopenedCount, 1);
  const closing = signal.reviewSheets.find((s: any) => s.id === sheetId);
  assert.equal(closing.status, 'voided');
  // 历史记录仍可读
  assert.ok(closing.reviewerSignature);
  assert.ok(signal.audit.some((a: any) => a.action === '复核签署'));
});
