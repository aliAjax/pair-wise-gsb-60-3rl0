import { z } from 'zod';

export const signalStatuses = [
  'new',
  'investigating',
  'observed',
  'action_required',
  'review',
  'closed'
] as const;

export const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
export const evidenceStrengths = ['strong', 'moderate', 'weak', 'contrary'] as const;

export const createSignalSchema = z.object({
  title: z.string().trim().min(6, '信号标题至少 6 个字符'),
  product: z.string().trim().min(2, '请输入产品名称'),
  batch: z.string().trim().min(2, '请输入批号'),
  sourceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report']),
  severity: z.coerce.number().int().min(1).max(5),
  occurredAt: z.string().min(1, '请选择发生日期'),
  description: z.string().trim().min(10, '经过说明至少 10 个字符')
});

export const transitionSchema = z.object({
  id: z.string().min(1),
  nextStatus: z.enum(signalStatuses),
  reason: z.string().trim().min(4, '请填写流转依据'),
  actor: z.string().trim().min(2, '请填写操作人')
});

export const evidenceSchema = z.object({
  id: z.string().min(1),
  evidenceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report', 'test', 'literature']),
  title: z.string().trim().min(4, '证据名称至少 4 个字符'),
  source: z.string().trim().min(2, '请填写来源'),
  strength: z.enum(evidenceStrengths),
  batch: z.string().trim().min(1, '请填写关联批号'),
  note: z.string().trim().min(4, '请填写核查说明')
});

export const versionSchema = z.object({
  id: z.string().min(1),
  author: z.string().trim().min(2, '请填写版本作者'),
  summary: z.string().trim().min(8, '结论摘要至少 8 个字符'),
  disposition: z.enum(['continue_observation', 'risk_communication', 'corrective_action']),
  rationale: z.string().trim().min(6, '请填写判断依据')
});

export const createReviewSchema = z.object({
  id: z.string().min(1),
  purpose: z.enum(['action_required', 'closed']),
  actor: z.string().trim().min(2, '请填写处置人姓名'),
  basisVersionId: z.string().min(1, '请选择作为复核依据的结论版本')
});

export const signReviewSchema = z.object({
  id: z.string().min(1),
  sheetId: z.string().min(1),
  actor: z.string().trim().min(2, '请填写复核人姓名'),
  expectedRevision: z.coerce.number().int().min(0)
});

export const assignReviewerSchema = z.object({
  id: z.string().min(1),
  sheetId: z.string().min(1),
  actor: z.string().trim().min(2, '请填写操作人姓名'),
  reviewer: z.string().trim().min(2, '请填写独立复核人姓名')
});

export const rejectReviewSchema = z.object({
  id: z.string().min(1),
  sheetId: z.string().min(1),
  actor: z.string().trim().min(2, '请填写复核人姓名'),
  reason: z.string().trim().min(6, '退回说明至少 6 个字符'),
  expectedRevision: z.coerce.number().int().min(0)
});

export const updateTaskSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  status: z.enum(['open', 'in_progress', 'done'])
});

export type SignalStatus = (typeof signalStatuses)[number];
export type RiskLevel = (typeof riskLevels)[number];
export type EvidenceStrength = (typeof evidenceStrengths)[number];
export type SignalSourceType = z.infer<typeof createSignalSchema>['sourceType'];
export type Disposition = z.infer<typeof versionSchema>['disposition'];

export interface EvidenceItem {
  id: string;
  type: SignalSourceType | 'test' | 'literature';
  title: string;
  source: string;
  strength: EvidenceStrength;
  batch: string;
  note: string;
  createdAt: string;
}

export interface InvestigationTask {
  id: string;
  title: string;
  owner: string;
  dueAt: string;
  status: 'open' | 'in_progress' | 'done';
}

export interface CaseVersion {
  id: string;
  version: number;
  author: string;
  summary: string;
  disposition: Disposition;
  rationale: string;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}

export type ReviewPurpose = 'action_required' | 'closed';
export type ReviewSheetStatus = 'pending' | 'completed' | 'voided';

export interface ReviewChecklist {
  /** 逐项确认：结论版本 */
  versionConfirmed: boolean;
  /** 逐项确认：关联批号 */
  batchesConfirmed: boolean;
  /** 逐项确认：未完成调查任务已全部关闭 */
  tasksConfirmed: boolean;
}

export interface ReviewSignature {
  actor: string;
  signedAt: string;
  checklist?: ReviewChecklist;
}

/**
 * 双人复核单：高及以上风险信号进入待处置/关闭前生成。
 * basis* 字段为发起时锁定的依据快照；revision 为乐观锁，
 * 任何使签署失效的变化都会令 revision 递增，先到一方生效、后到者收到冲突。
 */
export interface ReviewSheet {
  id: string;
  purpose: ReviewPurpose;
  status: ReviewSheetStatus;
  /** 发起时信号状态，退回时回到该状态 */
  fromStatus: SignalStatus;
  basisVersionId: string;
  basisVersionLabel: string;
  basisBatches: string[];
  basisOpenTasks: Array<{ id: string; title: string; owner: string }>;
  /** 发起时证据与结论版本的指纹，证据/结论变化后与当前值不一致即失效 */
  basisFingerprint: string;
  handlerSignature: ReviewSignature | null;
  reviewer: string | null;
  reviewerSignature: ReviewSignature | null;
  /** 复核人退回时填写的说明 */
  rejectionReason: string | null;
  voidedReason: string | null;
  revision: number;
  createdAt: string;
  completedAt: string | null;
}

export interface SignalCase {
  id: string;
  title: string;
  product: string;
  batch: string;
  sourceType: SignalSourceType;
  status: SignalStatus;
  riskLevel: RiskLevel;
  severity: number;
  reportCount: number;
  exposedUnits: number;
  occurrenceRate: number;
  occurredAt: string;
  openedAt: string;
  updatedAt: string;
  owner: string;
  description: string;
  affectedBatches: string[];
  evidence: EvidenceItem[];
  tasks: InvestigationTask[];
  versions: CaseVersion[];
  reviewSheets: ReviewSheet[];
  audit: AuditEntry[];
  reopenedCount: number;
}

export interface SignalFilters {
  query?: string;
  status?: SignalStatus | 'all';
  riskLevel?: RiskLevel | 'all';
  sourceType?: SignalSourceType | 'all';
}
