<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { ReviewChecklist, ReviewPurpose, SignalCase } from '$lib/models/signal';
  import {
    activeSheet,
    basisStillValid,
    openTasks,
    requiresDualReview,
    reviewPurposeLabels,
    sheetStatusLabels
  } from '$lib/services/review';
  import { signalStore } from '$lib/stores/signal-store';
  import ReviewSheetHistory from './ReviewSheetHistory.svelte';

  export let signal: SignalCase;

  let notice = '';
  let conflict = false;

  $: pendingSheet = activeSheet(signal);
  $: currentOpenTasks = openTasks(signal.tasks);
  $: basisValid = pendingSheet ? basisStillValid(signal, pendingSheet) : true;
  $: historicalSheets = signal.reviewSheets.filter((sheet) => sheet !== pendingSheet);

  const purposeOptions: Array<{ value: ReviewPurpose; label: string }> = [
    { value: 'action_required', label: '进入待处置（风险处置决策）' },
    { value: 'closed', label: '关闭信号' }
  ];

  const directTransitions: Array<{ value: SignalCase['status']; label: string }> = [
    { value: 'investigating', label: '转入调查' },
    { value: 'observed', label: '持续观察' }
  ];

  const checklistLabels: Array<{ key: keyof ReviewChecklist; label: string }> = [
    { key: 'versionConfirmed', label: '我已逐项核对结论版本内容，版本号与摘要与依据快照一致' },
    { key: 'batchesConfirmed', label: '我已逐项核对关联批号，覆盖范围与受影响批次一致' },
    { key: 'tasksConfirmed', label: '我已逐项核对调查任务，未完成事项已有处置安排或全部关闭' }
  ];

  function fail(message: string, isConflict = false) {
    notice = message;
    conflict = isConflict;
  }

  const requestHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          requestReview?: {
            id: string;
            purpose: ReviewPurpose;
            actor: string;
            basisVersionId: string;
          };
        };
        const req = payload.requestReview;
        if (req) {
          const res = await signalStore.requestReview(req.id, req.purpose, req.actor, req.basisVersionId);
          if (!res.ok) fail(res.message, res.conflict);
          else notice = '';
        }
      }
      await update({ reset: false });
    };
  };

  const signHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          signReview?: {
            id: string;
            sheetId: string;
            actor: string;
            expectedRevision: number;
            checklist: ReviewChecklist;
          };
        };
        const req = payload.signReview;
        if (req) {
          const res = await signalStore.signReview(
            req.id,
            req.sheetId,
            req.actor,
            req.expectedRevision,
            req.checklist
          );
          if (!res.ok) fail(res.message, res.conflict);
          else {
            notice = '';
            conflict = false;
          }
        }
      }
      await update({ reset: false });
    };
  };

  const assignHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          assignReviewer?: { id: string; sheetId: string; actor: string; reviewer: string };
        };
        const req = payload.assignReviewer;
        if (req) {
          const res = await signalStore.assignReviewer(req.id, req.sheetId, req.actor, req.reviewer);
          if (!res.ok) fail(res.message, res.conflict);
          else notice = '';
        }
      }
      await update({ reset: false });
    };
  };

  const rejectHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          rejectReview?: {
            id: string;
            sheetId: string;
            actor: string;
            reason: string;
            expectedRevision: number;
          };
        };
        const req = payload.rejectReview;
        if (req) {
          const res = await signalStore.rejectReview(
            req.id,
            req.sheetId,
            req.actor,
            req.reason,
            req.expectedRevision
          );
          if (!res.ok) fail(res.message, res.conflict);
          else notice = '';
        }
      }
      await update({ reset: false });
    };
  };

  const transitionHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          transition?: { id: string; nextStatus: SignalCase['status']; reason: string; actor: string };
        };
        if (payload.transition) {
          const res = await signalStore.transition(
            payload.transition.id,
            payload.transition.nextStatus,
            payload.transition.reason,
            payload.transition.actor
          );
          if (!res.ok) fail(res.message, res.conflict);
          else notice = '';
        }
      }
      await update({ reset: true });
    };
  };

  function fmt(iso: string) {
    return iso.slice(0, 16).replace('T', ' ');
  }
</script>

<div class="space-y-4">
  {#if notice}
    <div
      class="rounded border p-3 text-sm {conflict
        ? 'border-orange-400 bg-orange-50 text-orange-900'
        : 'border-error-300 bg-error-50 text-error-900'}"
      role="alert"
    >
      {#if conflict}<strong>签署冲突：</strong>{/if}{notice}
    </div>
  {/if}

  {#if signal.status === 'closed'}
    <div class="rounded border border-surface-300-700 bg-surface-200-800 p-3 text-sm text-surface-700-300">
      信号已关闭，全部记录保持只读；关闭时的双人复核单可在下方历史中查阅。新事件请使用“重新打开”。
    </div>
  {:else if requiresDualReview(signal.riskLevel)}
    {#if pendingSheet}
      <!-- ============ 待签署复核单 ============ -->
      <article class="rounded border-2 border-teal-600 bg-surface-100-900 p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="font-semibold">待签复核单 {pendingSheet.id.slice(-6)}</h3>
          <span class="badge bg-amber-100 text-amber-950">
            {sheetStatusLabels[pendingSheet.status]} · 修订 {pendingSheet.revision}
          </span>
        </div>
        <p class="mt-1 text-xs text-surface-500-400">
          复核目的：<strong>{reviewPurposeLabels[pendingSheet.purpose]}</strong>
          （发起于 {fmt(pendingSheet.createdAt)}）
        </p>

        {#if !basisValid}
          <p class="mt-3 rounded border border-orange-400 bg-orange-50 p-2 text-xs text-orange-900">
            依据快照与当前证据/结论不一致，签署将被拒绝并须重新发起复核。
          </p>
        {/if}

        <!-- 依据快照 -->
        <div class="mt-3 space-y-2 rounded border border-surface-300-700 p-3 text-xs">
          <p>
            <span class="text-surface-500-400">结论版本：</span>
            {pendingSheet.basisVersionLabel}
            {#if signal.versions[0]?.id !== pendingSheet.basisVersionId}
              <span class="ml-1 text-error-700">（已不是最新版本）</span>
            {/if}
          </p>
          <p>
            <span class="text-surface-500-400">关联批号：</span>
            {pendingSheet.basisBatches.join('、') || '无'}
          </p>
          <div>
            <span class="text-surface-500-400">发起时未完成任务（{pendingSheet.basisOpenTasks.length} 项）：</span>
            {#if pendingSheet.basisOpenTasks.length === 0}
              <span>无</span>
            {:else}
              <ul class="mt-1 list-disc pl-5">
                {#each pendingSheet.basisOpenTasks as task}
                  <li>{task.title} · {task.owner}</li>
                {/each}
              </ul>
            {/if}
            {#if currentOpenTasks.length !== pendingSheet.basisOpenTasks.length}
              <p class="mt-1 text-orange-800">
                当前未完成任务 {currentOpenTasks.length} 项，与快照不同，请复核人逐项核对。
              </p>
            {/if}
          </div>
          {#if pendingSheet.purpose === 'closed' && currentOpenTasks.length > 0}
            <p class="text-error-700">关闭复核要求所有调查任务完成，当前仍有 {currentOpenTasks.length} 项未完成。</p>
          {/if}
        </div>

        <!-- 处置人签署 -->
        <div class="mt-3 rounded border border-surface-300-700 p-3 text-sm">
          <p class="text-xs font-medium text-surface-500-400">处置人签署（发起时完成）</p>
          <p class="mt-1 font-medium">✓ {pendingSheet.handlerSignature?.actor}</p>
          <p class="text-xs text-surface-500-400">{fmt(pendingSheet.handlerSignature?.signedAt ?? '')}</p>
        </div>

        <!-- 指派/更换复核人 -->
        <div class="mt-3 rounded border border-surface-300-700 p-3">
          {#if pendingSheet.reviewer}
            <p class="text-sm">
              <span class="text-xs text-surface-500-400">当前独立复核人：</span>
              <strong>{pendingSheet.reviewer}</strong>
            </p>
            <details class="mt-2 text-xs">
              <summary class="cursor-pointer text-primary-700-300">更换复核人（留下审计依据）</summary>
              <form method="POST" action="?/assignReviewer" use:enhance={assignHandler} class="mt-2 flex gap-2">
                <input type="hidden" name="id" value={signal.id} />
                <input type="hidden" name="sheetId" value={pendingSheet.id} />
                <input class="input" name="actor" value={signal.owner} aria-label="操作人" placeholder="操作人" />
                <input class="input" name="reviewer" placeholder="新复核人姓名" />
                <button class="btn variant-soft-primary" type="submit">登记更换</button>
              </form>
            </details>
          {:else}
            <p class="text-xs text-surface-500-400">尚未登记独立复核人（须与处置人不同账号）。</p>
            <form method="POST" action="?/assignReviewer" use:enhance={assignHandler} class="mt-2 flex gap-2">
              <input type="hidden" name="id" value={signal.id} />
              <input type="hidden" name="sheetId" value={pendingSheet.id} />
              <input class="input" name="actor" value={signal.owner} aria-label="操作人" placeholder="操作人" />
              <input class="input" name="reviewer" placeholder="独立复核人姓名" />
              <button class="btn variant-soft-primary" type="submit">指派复核人</button>
            </form>
          {/if}
        </div>

        <!-- 复核人签署 -->
        <form method="POST" action="?/signReview" use:enhance={signHandler} class="mt-3 space-y-3 rounded border border-surface-300-700 p-3">
          <input type="hidden" name="id" value={signal.id} />
          <input type="hidden" name="sheetId" value={pendingSheet.id} />
          <!-- 乐观锁：另一窗口先签署会使 revision 变化，本次提交判定为后到一方 -->
          <input type="hidden" name="expectedRevision" value={pendingSheet.revision} />
          <p class="text-xs font-medium text-surface-500-400">复核人逐项确认后签署</p>
          <label class="block">
            <span class="mb-1 block text-xs">复核人账号（不可与处置人 {pendingSheet.handlerSignature?.actor} 相同）</span>
            <input class="input" name="actor" value={pendingSheet.reviewer ?? ''} placeholder="独立复核人姓名" />
          </label>
          <div class="space-y-2">
            {#each checklistLabels as item}
              <label class="flex items-start gap-2 text-xs leading-5">
                <input class="mt-0.5" type="checkbox" name={item.key} />
                <span>{item.label}</span>
              </label>
            {/each}
          </div>
          <button class="btn w-full variant-filled-primary" type="submit">
            复核人签署并{pendingSheet.purpose === 'closed' ? '关闭信号' : '进入待处置'}
          </button>
        </form>

        <!-- 复核人退回 -->
        <details class="mt-3">
          <summary class="cursor-pointer text-xs text-error-700">复核不通过，退回复核</summary>
          <form method="POST" action="?/rejectReview" use:enhance={rejectHandler} class="mt-2 space-y-2">
            <input type="hidden" name="id" value={signal.id} />
            <input type="hidden" name="sheetId" value={pendingSheet.id} />
            <input type="hidden" name="expectedRevision" value={pendingSheet.revision} />
            <input class="input" name="actor" value={pendingSheet.reviewer ?? ''} placeholder="复核人姓名" />
            <textarea class="textarea" name="reason" rows="2" placeholder="退回说明（至少 6 个字符），将写入审计记录"></textarea>
            <button class="btn w-full variant-soft-error" type="submit">退回复核并作废本单</button>
          </form>
        </details>
      </article>
    {:else}
      <!-- ============ 发起双人复核 ============ -->
      <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
        <h3 class="font-semibold">发起双人复核</h3>
        <p class="mt-1 text-xs text-surface-500-400">
          高及以上风险信号进入待处置或关闭前，须由处置人先生成复核单并签署，再由独立复核人逐项确认。
        </p>
        <form method="POST" action="?/requestReview" use:enhance={requestHandler} class="mt-3 space-y-3">
          <label class="block">
            <span class="mb-1 block text-xs font-medium">复核目的</span>
            <select class="select" name="purpose">
              {#each purposeOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium">复核依据（结论版本）</span>
            <select class="select" name="basisVersionId" disabled={signal.versions.length === 0}>
              {#each signal.versions as version}
                <option value={version.id}>V{version.version} · {version.summary}</option>
              {:else}
                <option>请先形成结论版本</option>
              {/each}
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium">处置人账号（发起即签署）</span>
            <input class="input" name="actor" value={signal.owner} />
          </label>
          <button class="btn w-full variant-filled-primary" type="submit" disabled={signal.versions.length === 0}>
            生成待签复核单
          </button>
          {#if currentOpenTasks.length > 0}
            <p class="text-xs text-surface-500-400">
              当前 {currentOpenTasks.length} 项调查任务未完成：可发起“进入待处置”复核；关闭复核须先完成全部任务。
            </p>
          {/if}
        </form>
      </article>

      <!-- 高风险信号的普通流转（不含待处置/关闭） -->
      <form method="POST" action="?/transition" use:enhance={transitionHandler} class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
        <h3 class="font-semibold">其他状态流转</h3>
        <p class="mt-1 text-xs text-surface-500-400">进入待处置或关闭只能通过上方双人复核完成。</p>
        <div class="mt-3 space-y-3">
          <input type="hidden" name="id" value={signal.id} />
          <label class="block">
            <span class="mb-1 block text-xs font-medium">目标状态</span>
            <select class="select" name="nextStatus">
              {#each directTransitions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium">操作人</span>
            <input class="input" name="actor" value={signal.owner} />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium">流转依据</span>
            <textarea class="textarea" name="reason" rows="2"></textarea>
          </label>
          <button class="btn w-full variant-filled-secondary" type="submit">提交流转</button>
        </div>
      </form>
    {/if}

    <!-- 复核单历史 -->
    {#if historicalSheets.length > 0}
      <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
        <h3 class="font-semibold">复核单历史</h3>
        <div class="mt-3 space-y-3">
          {#each historicalSheets as sheet}
            <ReviewSheetHistory {sheet} />
          {/each}
        </div>
      </article>
    {/if}
  {:else}
    <!-- 中低风险：维持原有直接流转 -->
    <form method="POST" action="?/transition" use:enhance={transitionHandler} class="space-y-3">
      <input type="hidden" name="id" value={signal.id} />
      <label class="block">
        <span class="mb-1 block text-sm font-medium">目标状态</span>
        <select class="select" name="nextStatus">
          <option value="investigating">转入调查</option>
          <option value="observed">持续观察</option>
          <option value="action_required">进入风险处置</option>
          <option value="review">提交复核</option>
          <option value="closed">关闭信号</option>
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
  {/if}
</div>
