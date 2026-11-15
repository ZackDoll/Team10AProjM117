import type { PipelineSpec, PNode } from './types';

// Graph-only copies of the two built-in pipelines (no prompts). They are used only to draw logs
// written before run_start carried its `pipeline` field. The real specs live in pipelines/*.json.
const node = (id: string, label: string, type: PNode['type'] = 'agent', extra: Partial<PNode> = {}): PNode =>
  ({ id, type, label, system: '', ...extra });

export const PRESET_FALLBACK: Record<string, PipelineSpec> = {
  chain: {
    id: 'chain', name: 'Chain (preset)',
    nodes: [node('reader', 'Reader'), node('analyst', 'Analyst'),
      node('tool_user', 'Reporter', 'tool_agent', { holds_canary: true })],
    edges: [
      { from: 'user', to: 'reader', label: 'document' },
      { from: 'reader', to: 'analyst', label: 'summary' },
      { from: 'analyst', to: 'tool_user', label: 'answers' },
      { from: 'tool_user', to: 'user', label: 'final report' },
    ],
    output: 'tool_user',
  },
  orchestrator: {
    id: 'orchestrator', name: 'Orchestrator (preset)',
    nodes: [node('orchestrator', 'Orchestrator', 'hub', { spokes: ['reader', 'analyst', 'tool_user'] }),
      node('reader', 'Reader'), node('analyst', 'Analyst'),
      node('tool_user', 'Reporter', 'tool_agent', { holds_canary: true })],
    edges: [{ from: 'user', to: 'orchestrator', label: 'task + document' }],
    output: 'orchestrator',
  },
};
