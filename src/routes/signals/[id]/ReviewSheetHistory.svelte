<script lang="ts">
  import type { ReviewSheet } from '$lib/models/signal';
  import { reviewPurposeLabels, sheetStatusLabels } from '$lib/services/review';

  export let sheet: ReviewSheet;

  function fmt(iso: string | null) {
    return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
  }

  const statusClass: Record<ReviewSheet['status'], string> = {
    pending: 'bg-amber-100 text-amber-950',
    completed: 'bg-emerald-100 text-emerald-900',
    voided: 'bg-surface-200-800 text-surface-600-300'
  };
</script>

<article class="rounded border border-surface-300-700 p-3 text-xs">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="font-medium text-sm">
      {sheet.id.slice(-6)} · {reviewPurposeLabels[sheet.purpose]}
    </p>
    <span class="badge {statusClass[sheet.status]}">{sheetStatusLabels[sheet.status]}</span>
  </div>
  <p class="mt-1 text-surface-500-400">依据版本：{sheet.basisVersionLabel}</p>
  <p class="mt-1 text-surface-500-400">关联批号：{sheet.basisBatches.join('、') || '无'}</p>
  <div class="mt-2 grid gap-1 sm:grid-cols-2">
    <p>
      处置人签署：
      {#if sheet.handlerSignature}
        <strong>{sheet.handlerSignature.actor}</strong> · {fmt(sheet.handlerSignature.signedAt)}
      {:else}
        未签署
      {/if}
    </p>
    <p>
      复核人签署：
      {#if sheet.reviewerSignature}
        <strong>{sheet.reviewerSignature.actor}</strong> · {fmt(sheet.reviewerSignature.signedAt)}
      {:else}
        未签署{sheet.reviewer ? `（已指派 ${sheet.reviewer}）` : ''}
      {/if}
    </p>
  </div>
  {#if sheet.reviewerSignature?.checklist}
    <p class="mt-2 text-surface-500-400">
      逐项确认：
      {sheet.reviewerSignature.checklist.versionConfirmed ? '✓结论版本 ' : '✗结论版本 '}
      {sheet.reviewerSignature.checklist.batchesConfirmed ? '✓关联批号 ' : '✗关联批号 '}
      {sheet.reviewerSignature.checklist.tasksConfirmed ? '✓调查任务' : '✗调查任务'}
    </p>
  {/if}
  {#if sheet.status === 'completed'}
    <p class="mt-1 text-emerald-800">双签完成于 {fmt(sheet.completedAt)}，作为状态流转依据。</p>
  {/if}
  {#if sheet.status === 'voided'}
    <p class="mt-1 text-surface-500-400">失效/退回：{sheet.voidedReason ?? sheet.rejectionReason}</p>
  {/if}
  {#if sheet.status !== 'completed'}
    <p class="mt-1 text-surface-500-400">末修订号：{sheet.revision}</p>
  {/if}
</article>
