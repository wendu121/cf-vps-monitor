/**
 * F6 · 多区域共识（D2-B 方案）
 *
 * 不移植 site-monitor 的「远程代理端点」玩法，改用 cf-vps-monitor 原生的
 * agent_probe_mode（真实 Agent 节点探测）——每个 Agent 上报的探测结果都带
 * source_client 落 website_checks，因此按节点分组多数表决即可得到共识。
 *
 * 阈值 CONSENSUS_MIN = 0.5（与 site-monitor prober.js 保持一致）。
 */

export const CONSENSUS_MIN = 0.5;

export interface ConsensusNode {
  /** 节点标识：Agent 的 client uuid，或 'worker'（Worker 自身探测） */
  node: string;
  /** 窗口内该节点的探测次数 */
  checks: number;
  /** 其中判定为可用的次数 */
  up: number;
  /** 该节点最近一次是否有可用记录 */
  any_up: boolean;
  /** 平均延迟（ms） */
  avg_latency_ms: number | null;
  last_checked_at: string | null;
  /** 最近一次失败原因 */
  last_error_reason: string | null;
}

export interface ConsensusResult {
  node_count: number;
  up_nodes: number;
  consensus_min: number;
  consensus_ratio: number | null;
  consensus_status: 'up' | 'down' | 'unknown';
  nodes: ConsensusNode[];
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeNode(raw: unknown): ConsensusNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const node = typeof r.node === 'string' && r.node ? r.node : null;
  if (!node) return null;
  return {
    node,
    checks: toNumber(r.checks) ?? 0,
    up: toNumber(r.up) ?? 0,
    any_up: Boolean(r.any_up),
    avg_latency_ms: toNumber(r.avg_latency_ms),
    last_checked_at: typeof r.last_checked_at === 'string' ? r.last_checked_at : null,
    last_error_reason: typeof r.last_error_reason === 'string' ? r.last_error_reason : null,
  };
}

/**
 * 纯函数：按节点多数表决计算共识。
 * - 无任何节点 → unknown（不伪装成功）
 * - up/total >= CONSENSUS_MIN → up，否则 down
 */
export function computeConsensus(rawNodes: unknown, min: number = CONSENSUS_MIN): ConsensusResult {
  const nodes: ConsensusNode[] = [];
  if (Array.isArray(rawNodes)) {
    for (const item of rawNodes) {
      const n = normalizeNode(item);
      if (n) nodes.push(n);
    }
  }
  nodes.sort((a, b) => a.node.localeCompare(b.node));

  const node_count = nodes.length;
  const up_nodes = nodes.filter(n => n.any_up).length;
  if (node_count === 0) {
    return { node_count: 0, up_nodes: 0, consensus_min: min, consensus_ratio: null, consensus_status: 'unknown', nodes };
  }

  const ratio = up_nodes / node_count;
  return {
    node_count,
    up_nodes,
    consensus_min: min,
    consensus_ratio: Math.round(ratio * 1000) / 1000,
    consensus_status: ratio >= min ? 'up' : 'down',
    nodes,
  };
}
