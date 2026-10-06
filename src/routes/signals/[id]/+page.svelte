<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import EvidenceMatrix from '$lib/components/EvidenceMatrix.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import type {
    CaseVersion,
    EvidenceItem,
    InvestigationTask,
    ReviewSheet,
    SignalStatus
  } from '$lib/models/signal';
  import { isHighSeverity } from '$lib/models/signal';
  import { exportSignalReport } from '$lib/services/signal-service';
  import { activeReviewSheet, signalStore, targetLabel } from '$lib/stores/signal-store';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  $: signal = $signalStore.find((item) => item.id === data.id);
  $: nextVersion = (signal?.versions[0]?.version ?? 0) + 1;
  $: highSeverity = signal ? isHighSeverity(signal) : false;
  $: activeSheet = signal ? activeReviewSheet(signal) : undefined;
  $: closed = signal?.status === 'closed';

  // 复核人勾选状态：每个未完成任务逐项确认
  let reviewConfirmsVersion = false;
  let reviewConfirmsBatches = false;
  let reviewConfirmedTasks: string[] = [];
  let notice: { kind: 'error' | 'success'; text: string } | null = null;

  $: if (form?.message) notice = { kind: 'error', text: form.message };
  $: if (signal && activeSheet) {
    reviewConfirmedTasks = activeSheet.openTaskSnapshot
      .map((task) => task.id)
      .filter((taskId) => reviewConfirmedTasks.includes(taskId));
  }

  function toggleTask(taskId: string, checked: boolean) {
    if (checked) {
      reviewConfirmedTasks = [...new Set([...reviewConfirmedTasks, taskId])];
    } else {
      reviewConfirmedTasks = reviewConfirmedTasks.filter((id) => id !== taskId);
    }
  }

  const statusOptions: Array<{ value: SignalStatus; label: string }> = [
    { value: 'investigating', label: '转入调查' },
    { value: 'observed', label: '持续观察' },
    { value: 'review', label: '提交复核' }
  ];

  $: guardedOptions = highSeverity
    ? statusOptions
    : [
        ...statusOptions,
        { value: 'action_required' as SignalStatus, label: '进入风险处置' },
        { value: 'closed' as SignalStatus, label: '关闭信号' }
      ];

  const transitionHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          transition?: { id: string; nextStatus: SignalStatus; reason: string; actor: string };
        };
        if (payload.transition && signal) {
          const outcome = signalStore.transition(
            payload.transition.id,
            payload.transition.nextStatus,
            payload.transition.reason,
            payload.transition.actor
          );
          notice = outcome.ok
            ? { kind: 'success', text: '状态流转已记录。' }
            : { kind: 'error', text: outcome.error ?? '状态流转失败。' };
        }
      }
      await update({ reset: false });
    };
  };

  function handleMutation<T>(outcome: { ok: boolean; error?: string; token?: string }, success: string) {
    notice = outcome.ok ? { kind: 'success', text: success } : { kind: 'error', text: outcome.error ?? '操作失败。' };
  }

  const fmt = (value: string) => value.slice(0, 16).replace('T', ' ');

  function sheetStatusBadge(sheet: ReviewSheet) {
    if (sheet.status === 'countersigned') return '已完成会签';
    if (sheet.status === 'invalidated') return '已失效';
    return '待签署';
  }
</script>

<svelte:head><title>{signal?.id ?? data.id} | 信号核查详情</title></svelte:head>

{#if !signal}
  <section class="rounded border border-error-300 bg-error-50 p-6 text-error-900">
    未找到信号 {data.id}。它可能已被本地数据重置。
  </section>
{:else}
  <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex flex-wrap items-center gap-3">
        <a class="text-sm text-primary-700-300 hover:underline" href="/signals">返回信号台账</a>
        <span class="text-surface-400">/</span>
        <span class="text-sm text-surface-500-400">{signal.id}</span>
      </div>
      <h1 class="mt-3 max-w-4xl text-2xl font-semibold">{signal.title}</h1>
      <div class="mt-3"><RiskBadge risk={signal.riskLevel} status={signal.status} /></div>
      {#if highSeverity}
        <p class="mt-2 text-xs font-medium text-red-700">高严重度信号：进入待处置或关闭须由处置人与独立复核人先后签署。</p>
      {/if}
    </div>
    <button class="btn variant-soft-primary" type="button" on:click={() => exportSignalReport(signal.id)}>
      导出可追溯报告
    </button>
  </div>

  {#if notice}
    <div
      class="mb-5 rounded border p-3 text-sm {notice.kind === 'error'
        ? 'border-error-300 bg-error-50 text-error-900'
        : 'border-emerald-300 bg-emerald-50 text-emerald-900'}"
    >
      {notice.text}
    </div>
  {/if}

  <section class="workspace-grid mb-6">
    <article class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 xl:col-span-8">
      <div class="grid gap-5 md:grid-cols-2">
        <div>
          <p class="text-xs font-medium text-surface-500-400">产品与批号</p>
          <p class="mt-1 font-medium">{signal.product}</p>
          <p class="mt-1 text-sm text-surface-600-300">{signal.affectedBatches.join(' / ')}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">调查负责人</p>
          <p class="mt-1 font-medium">{signal.owner}</p>
          <p class="mt-1 text-sm text-surface-600-300">最后更新 {fmt(signal.updatedAt)}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">报告与暴露</p>
          <p class="metric-value mt-1 font-medium">{signal.reportCount} 条 / {signal.exposedUnits} 台</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">核查发生率</p>
          <p class="metric-value mt-1 font-medium">{signal.occurrenceRate.toFixed(2)}%</p>
        </div>
      </div>
      <div class="section-rule mt-5 pt-5">
        <p class="text-sm leading-6 text-surface-700-300">{signal.description}</p>
      </div>
    </article>

    <aside class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 xl:col-span-4">
      <h2 class="font-semibold">状态流转</h2>
      {#if highSeverity}
        <p class="mt-1 text-xs text-red-700">
          高严重度信号不能直接流转至待处置或关闭，须先在下方发起双人复核并完成会签。
        </p>
      {:else}
        <p class="mt-1 text-xs text-surface-500-400">每次流转都记录依据、操作人和时间。</p>
      {/if}

      {#if !closed}
        <form class="mt-4 space-y-3" method="POST" action="?/transition" use:enhance={transitionHandler}>
          <input type="hidden" name="id" value={signal.id} />
          <label class="block">
            <span class="mb-1 block text-sm font-medium">目标状态</span>
            <select class="select" name="nextStatus">
              {#each guardedOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-sm font-medium">操作人</span>
            <input class="input" name="actor" value={signal.owner} />
          </label>
          <label class="block">
            <span class="mb-1 block text-sm font-medium">流转依据</span>
            <textarea class="textarea" name="reason" rows="3" placeholder="说明新增证据、风险判断或复核结论"></textarea>
          </label>
          <button class="btn w-full variant-filled-primary" type="submit">提交状态流转</button>
        </form>
      {:else}
        <div class="section-rule mt-5 rounded bg-surface-200-800 p-3 pt-4 text-xs text-surface-600-300">
          信号已关闭：证据、结论版本、任务与复核单保持只读，历史会签与审计记录可随时查阅。
        </div>
        <div class="section-rule mt-5 pt-5">
          <h3 class="font-medium">新事件重新打开</h3>
          <p class="mt-1 text-xs text-surface-500-400">关闭信号收到新报告时，不允许静默修改结论；新处置须重新双人会签。</p>
          <form
            class="mt-3 space-y-3"
            method="POST"
            action="?/reopen"
            use:enhance={() =>
              async ({ result, update }) => {
                if (result.type === 'success') {
                  const payload = result.data as { reopen?: { id: string; actor: string; reason: string } };
                  if (payload.reopen) {
                    const outcome = signalStore.reopen(payload.reopen.id, payload.reopen.actor, payload.reopen.reason);
                    handleMutation(outcome, '信号已重新打开，历史会签保留可读，请重新发起复核。');
                  }
                }
                await update({ reset: true });
              }}
          >
            <input type="hidden" name="id" value={signal.id} />
            <input class="input" name="actor" value={signal.owner} aria-label="操作人" />
            <textarea class="textarea" name="reason" rows="2" placeholder="描述新报告及其影响"></textarea>
            <button class="btn w-full variant-soft-error" type="submit">重新打开信号</button>
          </form>
        </div>
      {/if}
    </aside>
  </section>

  <!-- 双人复核流程 -->
  <section class="mb-6 rounded border-2 border-red-300 bg-surface-100-900 p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">双人复核会签</h2>
        <p class="mt-1 text-sm text-surface-500-400">
          高严重度信号进入待处置或关闭前生成待签复核单；处置人先签署，独立复核人逐项确认结论版本、关联批号与未完成调查任务后再签署。处置人不能批准自己的复核。
        </p>
      </div>
      {#if activeSheet}
        <span class="badge bg-amber-100 px-3 py-1 text-amber-950">
          待签复核单 · 目标：{targetLabel(activeSheet.target)} · 修订 {activeSheet.revision}
        </span>
      {/if}
    </div>

    {#if activeSheet}
      {@const boundVersion = signal.versions.find((version) => version.id === activeSheet.versionId)}
      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <article class="rounded border border-surface-300-700 p-4">
          <h3 class="font-medium">复核单 {activeSheet.id} · 冻结依据</h3>
          <dl class="mt-3 space-y-2 text-sm">
            <div class="flex gap-2">
              <dt class="w-24 shrink-0 text-surface-500-400">目标状态</dt>
              <dd>{targetLabel(activeSheet.target)}</dd>
            </div>
            <div class="flex gap-2">
              <dt class="w-24 shrink-0 text-surface-500-400">结论版本</dt>
              <dd>
                {#if boundVersion}
                  V{boundVersion.version} · {boundVersion.author} · {boundVersion.summary}
                {:else}
                  <span class="text-error-700">绑定版本已不存在，复核单须作废重开</span>
                {/if}
              </dd>
            </div>
            <div class="flex gap-2">
              <dt class="w-24 shrink-0 text-surface-500-400">关联批号</dt>
              <dd>{activeSheet.batchSnapshot.join(' / ') || '（无）'}</dd>
            </div>
            <div class="flex gap-2">
              <dt class="w-24 shrink-0 text-surface-500-400">发起依据</dt>
              <dd>{activeSheet.reason}</dd>
            </div>
          </dl>
          <div class="mt-3">
            <p class="text-sm font-medium">未完成调查任务（{activeSheet.openTaskSnapshot.length} 项）</p>
            <ul class="mt-2 space-y-1 text-sm text-surface-600-300">
              {#each activeSheet.openTaskSnapshot as task}
                <li>· {task.title}（{task.owner} · 截止 {task.dueAt}）</li>
              {:else}
                <li class="text-surface-500-400">发起时无未完成任务。</li>
              {/each}
            </ul>
          </div>
        </article>

        <article class="rounded border border-surface-300-700 p-4">
          <h3 class="font-medium">签署进度</h3>

          <div class="mt-3 rounded border border-surface-300-700 p-3">
            <p class="text-sm font-medium">① 处置人签署 {activeSheet.handlerSignature ? '✓' : '（待签）'}</p>
            {#if activeSheet.handlerSignature}
              <p class="mt-1 text-xs text-surface-500-400">
                {activeSheet.handlerSignature.actor} · {fmt(activeSheet.handlerSignature.signedAt)} · 基于修订 {activeSheet.handlerSignature.signedRevision}
              </p>
            {:else if !closed}
              <form
                class="mt-2 space-y-2"
                method="POST"
                action="?/signReview"
                use:enhance={() =>
                  async ({ result }) => {
                    if (result.type === 'success') {
                      const payload = result.data as {
                        signReview?: {
                          id: string;
                          sheetId: string;
                          role: 'handler';
                          actor: string;
                          baseRevision: number;
                          token: string;
                          confirmsVersion: boolean;
                          confirmsBatches: boolean;
                          confirmedTaskIds: string[];
                        };
                      };
                      const input = payload.signReview;
                      if (input && signal) {
                        const outcome = signalStore.signReview({
                          ...input,
                          confirmsVersion: true,
                          confirmsBatches: true,
                          confirmedTaskIds: activeSheet.openTaskSnapshot.map((task) => task.id)
                        });
                        handleMutation(outcome, '处置人签署完成，等待独立复核人逐项确认。');
                      }
                    }
                  }}
              >
                <input type="hidden" name="id" value={signal.id} />
                <input type="hidden" name="sheetId" value={activeSheet.id} />
                <input type="hidden" name="role" value="handler" />
                <input type="hidden" name="baseRevision" value={activeSheet.revision} />
                <input type="hidden" name="storeToken" value={signalStore.getToken()} />
                <input type="hidden" name="confirmsVersion" value="on" />
                <input type="hidden" name="confirmsBatches" value="on" />
                {#each activeSheet.openTaskSnapshot as task}
                  <input type="hidden" name="confirmsTask" value={task.id} />
                {/each}
                <label class="block text-xs">
                  <span class="mb-1 block text-surface-500-400">处置人姓名（不得与复核人相同）</span>
                  <input class="input" name="actor" value={activeSheet.openedBy} required />
                </label>
                <button class="btn btn-sm variant-filled-secondary" type="submit">处置人签署</button>
              </form>
            {/if}
          </div>

          <div class="mt-3 rounded border border-surface-300-700 p-3">
            <p class="text-sm font-medium">② 独立复核人会签 {activeSheet.reviewerSignature ? '✓' : '（待签）'}</p>
            {#if activeSheet.reviewerSignature}
              <p class="mt-1 text-xs text-surface-500-400">
                {activeSheet.reviewerSignature.actor} · {fmt(activeSheet.reviewerSignature.signedAt)} · 基于修订 {activeSheet.reviewerSignature.signedRevision}
              </p>
            {:else if activeSheet.handlerSignature && !closed}
              <form
                class="mt-2 space-y-2"
                method="POST"
                action="?/signReview"
                use:enhance={() =>
                  async ({ result }) => {
                    if (result.type === 'success') {
                      const payload = result.data as {
                        signReview?: {
                          id: string;
                          sheetId: string;
                          role: 'reviewer';
                          actor: string;
                          baseRevision: number;
                          token: string;
                          confirmedTaskIds: string[];
                        };
                      };
                      const input = payload.signReview;
                      if (input && signal) {
                        const outcome = signalStore.signReview({
                          ...input,
                          confirmsVersion: reviewConfirmsVersion,
                          confirmsBatches: reviewConfirmsBatches,
                          confirmedTaskIds: reviewConfirmedTasks
                        });
                        handleMutation(
                          outcome,
                          `复核人会签完成，信号已${targetLabel(activeSheet.target) === '待处置' ? '进入待处置' : '关闭'}。`
                        );
                        reviewConfirmsVersion = false;
                        reviewConfirmsBatches = false;
                        reviewConfirmedTasks = [];
                      }
                    }
                  }}
              >
                <input type="hidden" name="id" value={signal.id} />
                <input type="hidden" name="sheetId" value={activeSheet.id} />
                <input type="hidden" name="role" value="reviewer" />
                <input type="hidden" name="baseRevision" value={activeSheet.revision} />
                <input type="hidden" name="storeToken" value={signalStore.getToken()} />

                <p class="text-xs font-medium text-surface-500-400">请逐项核对并勾选：</p>
                <label class="flex items-start gap-2 text-sm">
                  <input
                    class="mt-1"
                    type="checkbox"
                    name="confirmsVersion"
                    bind:checked={reviewConfirmsVersion}
                  />
                  <span>已核对结论版本（V{boundVersion?.version ?? '?'}）与判断依据、替代解释一致。</span>
                </label>
                <label class="flex items-start gap-2 text-sm">
                  <input
                    class="mt-1"
                    type="checkbox"
                    name="confirmsBatches"
                    bind:checked={reviewConfirmsBatches}
                  />
                  <span>已核对关联批号 {activeSheet.batchSnapshot.join(' / ')} 与证据矩阵覆盖范围一致。</span>
                </label>
                <div class="space-y-1">
                  {#each activeSheet.openTaskSnapshot as task}
                    <label class="flex items-start gap-2 text-sm">
                      <input
                        class="mt-1"
                        type="checkbox"
                        name="confirmsTask"
                        value={task.id}
                        checked={reviewConfirmedTasks.includes(task.id)}
                        on:change={(event) => toggleTask(task.id, event.currentTarget.checked)}
                      />
                      <span>已确认未完成任务「{task.title}」（{task.owner}）的处置安排。</span>
                    </label>
                  {:else}
                    <p class="text-xs text-surface-500-400">无未完成任务需要逐项确认。</p>
                  {/each}
                </div>
                <label class="block text-xs">
                  <span class="mb-1 block text-surface-500-400">复核人姓名（必须独立于处置人 {activeSheet.handlerSignature?.actor}）</span>
                  <input class="input" name="actor" required placeholder="请输入独立复核人姓名" />
                </label>
                <button class="btn btn-sm variant-filled-primary" type="submit">复核人逐项确认并签署</button>
              </form>
            {:else if !activeSheet.handlerSignature}
              <p class="mt-1 text-xs text-surface-500-400">须先由处置人签署，复核人才能开始逐项确认。</p>
            {/if}
          </div>

          <p class="mt-3 text-xs text-surface-500-400">
            证据、结论版本或调查任务一旦变化，原签署立即失效并退回复核；两个窗口同时签署时仅先到者生效。
          </p>
        </article>
      </div>
    {:else if highSeverity && !closed}
      <!-- 尚无待签复核单：处置人发起 -->
      <form
        class="mt-4 grid gap-4 rounded border border-surface-300-700 p-4 md:grid-cols-2"
        method="POST"
        action="?/requestReview"
        use:enhance={() =>
          async ({ result }) => {
            if (result.type === 'success') {
              const payload = result.data as {
                requestReview?: {
                  id: string;
                  target: 'action_required' | 'closed';
                  handler: string;
                  reason: string;
                  versionId: string;
                  token: string;
                };
              };
              const input = payload.requestReview;
              if (input && signal) {
                const outcome = signalStore.requestReview(input);
                handleMutation(outcome, '待签复核单已生成，处置人已签署，请交独立复核人逐项确认。');
              }
            }
          }}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="storeToken" value={signalStore.getToken()} />
        <label>
          <span class="mb-1 block text-sm font-medium">复核目标</span>
          <select class="select" name="target">
            <option value="action_required">进入待处置</option>
            <option value="closed">关闭信号</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">绑定结论版本</span>
          <select class="select" name="versionId">
            {#each signal.versions as version}
              <option value={version.id}>V{version.version} · {version.summary.slice(0, 24)}</option>
            {:else}
              <option value="">请先形成结论版本</option>
            {/each}
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">处置人（发起人）</span>
          <input class="input" name="handler" value={signal.owner} required />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">发起依据</span>
          <input class="input" name="reason" placeholder="说明申请进入待处置/关闭的理由" required minlength="4" />
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-secondary" type="submit" disabled={signal.versions.length === 0}>
            生成待签复核单并由处置人签署
          </button>
          {#if signal.versions.length === 0}
            <p class="mt-1 text-xs text-error-700">复核单必须绑定结论版本，请先在下方形成结论版本。</p>
          {/if}
        </div>
      </form>
    {/if}

    {#if signal.reviewSheets.filter((sheet) => sheet.status !== 'pending').length > 0}
      <div class="section-rule mt-5 pt-4">
        <h3 class="text-sm font-semibold">历史复核单（只读留痕）</h3>
        <div class="mt-3 space-y-2">
          {#each signal.reviewSheets.filter((sheet) => sheet.status !== 'pending') as sheet}
            <div class="flex flex-wrap items-center justify-between gap-2 rounded border border-surface-300-700 px-3 py-2 text-xs">
              <span>
                {sheet.id} · 目标：{targetLabel(sheet.target)} ·
                处置人 {sheet.handlerSignature?.actor ?? '—'} / 复核人 {sheet.reviewerSignature?.actor ?? '—'}
              </span>
              <span class:list={[{ 'text-emerald-700': sheet.status === 'countersigned', 'text-error-700': sheet.status === 'invalidated' }]}>
                {sheetStatusBadge(sheet)}
                {#if sheet.status === 'invalidated' && sheet.invalidatedReason}· {sheet.invalidatedReason}{/if}
              </span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </section>

  <!-- 调查任务维护：任务变化同样会使待签复核单失效 -->
  <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="font-semibold">调查任务</h2>
        <p class="mt-1 text-xs text-surface-500-400">复核单冻结未完成任务清单；任务状态变化后原签署失效，须退回复核重新逐项确认。</p>
      </div>
    </div>
    <div class="mt-4 space-y-3">
      {#each signal.tasks as task}
        <div class="flex flex-wrap items-center justify-between gap-3 rounded border border-surface-300-700 px-3 py-2">
          <div>
            <p class="text-sm font-medium">{task.title}</p>
            <p class="text-xs text-surface-500-400">{task.owner} · 截止 {task.dueAt}</p>
          </div>
          {#if !closed}
            <form
              method="POST"
              action="?/task"
              class="flex items-center gap-2"
              use:enhance={() =>
                async ({ result }) => {
                  if (result.type === 'success') {
                    const payload = result.data as {
                      task?: { id: string; taskId: string; status: InvestigationTask['status']; actor: string; token: string };
                    };
                    const data2 = payload.task;
                    if (data2 && signal) {
                      const current = signal.tasks.find((item) => item.id === data2.taskId);
                      if (current) {
                        const outcome = signalStore.replaceTask(
                          data2.id,
                          { ...current, status: data2.status },
                          data2.token
                        );
                        handleMutation(outcome, `任务「${current.title}」已更新为 ${data2.status}。`);
                      }
                    }
                  }
                }}
            >
              <input type="hidden" name="id" value={signal.id} />
              <input type="hidden" name="taskId" value={task.id} />
              <input type="hidden" name="actor" value={signal.owner} />
              <input type="hidden" name="storeToken" value={signalStore.getToken()} />
              <select class="select" name="status">
                <option value="open" selected={task.status === 'open'}>待办</option>
                <option value="in_progress" selected={task.status === 'in_progress'}>进行中</option>
                <option value="done" selected={task.status === 'done'}>已完成</option>
              </select>
              <button class="btn btn-sm variant-soft-primary" type="submit">更新</button>
            </form>
          {:else}
            <span class="text-xs text-surface-500-400">{task.status === 'done' ? '已完成' : task.status}</span>
          {/if}
        </div>
      {/each}
    </div>
  </section>

  <section class="mb-6">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">证据矩阵</h2>
        <p class="mt-1 text-sm text-surface-500-400">强支持、弱支持和相反证据并列保存，不覆盖替代解释。新增证据会使待签复核单失效。</p>
      </div>
      <span class="badge">{signal.evidence.length} 项证据</span>
    </div>
    <EvidenceMatrix evidence={signal.evidence} />
  </section>

  <div class="grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">补充核查证据</h2>
      {#if closed}
        <p class="mt-3 text-sm text-surface-500-400">信号已关闭，证据补充入口已锁定；请先重新打开。</p>
      {:else}
        <form
          class="mt-4 grid gap-4 md:grid-cols-2"
          method="POST"
          action="?/evidence"
          use:enhance={() =>
            async ({ result, update }) => {
              if (result.type === 'success') {
                const payload = result.data as { evidence?: EvidenceItem; actor?: string; token?: string };
                if (payload.evidence && signal) {
                  const outcome = signalStore.addEvidence(signal.id, payload.evidence, payload.actor ?? signal.owner);
                  handleMutation(outcome, '证据已加入矩阵；未生效复核单已退回复核。');
                }
              }
              await update({ reset: true });
            }}
        >
          <input type="hidden" name="id" value={signal.id} />
          <input type="hidden" name="storeToken" value={signalStore.getToken()} />
          <label>
            <span class="mb-1 block text-sm font-medium">证据类型</span>
            <select class="select" name="evidenceType">
              <option value="complaint">投诉</option>
              <option value="repair">维修</option>
              <option value="adverse_event">不良事件</option>
              <option value="field_report">现场报告</option>
              <option value="test">测试</option>
              <option value="literature">文献</option>
            </select>
          </label>
          <label>
            <span class="mb-1 block text-sm font-medium">证据强度</span>
            <select class="select" name="strength">
              <option value="strong">强支持</option>
              <option value="moderate">中等支持</option>
              <option value="weak">弱支持</option>
              <option value="contrary">相反证据</option>
            </select>
          </label>
          <label>
            <span class="mb-1 block text-sm font-medium">证据名称</span>
            <input class="input" name="title" />
          </label>
          <label>
            <span class="mb-1 block text-sm font-medium">来源</span>
            <input class="input" name="source" />
          </label>
          <label>
            <span class="mb-1 block text-sm font-medium">关联批号</span>
            <input class="input" name="batch" value={signal.batch} />
          </label>
          <label>
            <span class="mb-1 block text-sm font-medium">录入人</span>
            <input class="input" name="actor" value={signal.owner} />
          </label>
          <label class="md:col-span-2">
            <span class="mb-1 block text-sm font-medium">核查说明</span>
            <textarea class="textarea" name="note" rows="3"></textarea>
          </label>
          <div class="md:col-span-2">
            <button class="btn variant-filled-primary" type="submit">加入证据矩阵</button>
          </div>
        </form>
      {/if}
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">形成结论版本</h2>
      {#if closed}
        <p class="mt-3 text-sm text-surface-500-400">信号已关闭，结论版本保持只读；请先重新打开。</p>
      {:else}
        <form
          class="mt-4 grid gap-4 md:grid-cols-2"
          method="POST"
          action="?/version"
          use:enhance={() =>
            async ({ result, update }) => {
              if (result.type === 'success') {
                const payload = result.data as { version?: CaseVersion; actor?: string; token?: string };
                if (payload.version && signal) {
                  const outcome = signalStore.addVersion(signal.id, payload.version, payload.actor ?? signal.owner);
                  handleMutation(outcome, `V${payload.version.version} 已保存；待签复核单须改用新版本重新发起。`);
                }
              }
              await update({ reset: true });
            }}
        >
          <input type="hidden" name="id" value={signal.id} />
          <input type="hidden" name="versionNumber" value={nextVersion} />
          <input type="hidden" name="storeToken" value={signalStore.getToken()} />
          <label>
            <span class="mb-1 block text-sm font-medium">版本作者</span>
            <input class="input" name="author" value={signal.owner} />
          </label>
          <label>
            <span class="mb-1 block text-sm font-medium">建议处置</span>
            <select class="select" name="disposition">
              <option value="continue_observation">继续观察</option>
              <option value="risk_communication">风险沟通</option>
              <option value="corrective_action">纠正措施</option>
            </select>
          </label>
          <label class="md:col-span-2">
            <span class="mb-1 block text-sm font-medium">结论摘要</span>
            <textarea class="textarea" name="summary" rows="2"></textarea>
          </label>
          <label class="md:col-span-2">
            <span class="mb-1 block text-sm font-medium">判断依据与替代解释</span>
            <textarea class="textarea" name="rationale" rows="3"></textarea>
          </label>
          <div class="md:col-span-2">
            <button class="btn variant-filled-secondary" type="submit">保存为 V{nextVersion}</button>
          </div>
        </form>
      {/if}
    </section>
  </div>

  <div class="mt-6 grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">结论版本</h2>
      <div class="mt-4 space-y-4">
        {#each signal.versions as version}
          <article class="border-l-2 border-teal-600 pl-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">V{version.version} · {version.author}</p>
              <span class="text-xs text-surface-500-400">{version.createdAt.slice(0, 10)}</span>
            </div>
            <p class="mt-2 text-sm">{version.summary}</p>
            <p class="mt-2 text-xs text-surface-500-400">{version.rationale}</p>
          </article>
        {:else}
          <p class="text-sm text-surface-500-400">尚未形成正式结论版本。</p>
        {/each}
      </div>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">审计记录</h2>
      <div class="mt-4 space-y-5">
        {#each signal.audit as entry}
          <div class="timeline-item">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm font-medium">{entry.action} · {entry.actor}</p>
              <span class="text-xs text-surface-500-400">{fmt(entry.createdAt)}</span>
            </div>
            <p class="mt-1 text-xs text-surface-500-400">{entry.detail}</p>
          </div>
        {/each}
      </div>
    </section>
  </div>
{/if}
