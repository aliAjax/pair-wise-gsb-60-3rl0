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

export const reviewTargets = ['action_required', 'closed'] as const;
export const reviewRoles = ['handler', 'reviewer'] as const;

// 高严重度信号进入待处置或关闭前，由处置人发起并签署待签复核单
export const requestReviewSchema = z.object({
  id: z.string().min(1),
  target: z.enum(reviewTargets, { message: '请选择复核目标状态' }),
  handler: z.string().trim().min(2, '请填写处置人姓名'),
  reason: z.string().trim().min(4, '请填写发起复核的依据'),
  versionId: z.string().min(1, '复核单必须绑定结论版本'),
  storeToken: z.string().min(1)
});

// 独立复核人逐项确认结论版本、关联批号与未完成调查任务后才能签署
export const signReviewSchema = z.object({
  id: z.string().min(1),
  sheetId: z.string().min(1),
  role: z.enum(reviewRoles),
  actor: z.string().trim().min(2, '请填写签署人姓名'),
  baseRevision: z.coerce.number().int().min(0),
  storeToken: z.string().min(1),
  confirmsVersion: z.literal('on', { message: '请逐项确认结论版本' }),
  confirmsBatches: z.literal('on', { message: '请逐项确认关联批号' }),
  confirmsTask: z.array(z.string()).default([])
});

export const taskSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  status: z.enum(['open', 'in_progress', 'done']),
  actor: z.string().trim().min(2, '请填写操作人')
});

export type SignalStatus = (typeof signalStatuses)[number];
export type RiskLevel = (typeof riskLevels)[number];
export type EvidenceStrength = (typeof evidenceStrengths)[number];
export type SignalSourceType = z.infer<typeof createSignalSchema>['sourceType'];
export type Disposition = z.infer<typeof versionSchema>['disposition'];
export type ReviewTarget = (typeof reviewTargets)[number];
export type ReviewRole = (typeof reviewRoles)[number];

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

export interface ReviewChecklist {
  confirmsVersion: boolean;
  confirmsBatches: boolean;
  confirmedTaskIds: string[];
}

export interface ReviewSignature {
  role: ReviewRole;
  actor: string;
  checklist: ReviewChecklist;
  signedAt: string;
  // 签署基于的复核单修订号；复核单内容变化后旧签署不再生效
  signedRevision: number;
}

export interface ReviewSheet {
  id: string;
  // 会签目标：进入待处置或关闭
  target: ReviewTarget;
  reason: string;
  status: 'pending' | 'countersigned' | 'invalidated';
  revision: number;
  // 发起时冻结的快照：结论版本、关联批号、未完成任务与证据指纹
  versionId: string;
  batchSnapshot: string[];
  openTaskSnapshot: Array<{ id: string; title: string; owner: string; dueAt: string }>;
  evidenceFingerprint: string;
  openedBy: string;
  openedAt: string;
  // 处置人先签署，独立复核人后签署；同槽位至多一份有效签署
  handlerSignature: ReviewSignature | null;
  reviewerSignature: ReviewSignature | null;
  countersignedAt: string | null;
  invalidatedAt: string | null;
  invalidatedReason: string | null;
}

/** 高严重度信号：高风险及严重风险，必须双人会签后才能进入待处置或关闭 */
export function isHighSeverity(signal: Pick<SignalCase, 'riskLevel'> | RiskLevel): boolean {
  const level = typeof signal === 'string' ? signal : signal.riskLevel;
  return level === 'high' || level === 'critical';
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
