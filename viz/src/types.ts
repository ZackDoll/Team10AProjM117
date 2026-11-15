/** One JSONL line of a run log. Fields vary by `event`; see docs/LOG_SCHEMA.md. */
export type Ev = { event: string; [key: string]: any };

/** A pipeline id: "chain", "orchestrator", or a custom pipeline's id. */
export type Topology = string;

export type NodeType = 'agent' | 'tool_agent' | 'hub';

export interface PNode {
  id: string;
  type: NodeType;
  label: string;
  system: string;
  /** what the model actually received (placeholders filled in); only in logged specs */
  system_rendered?: string;
  holds_canary?: boolean;
  /** hubs only: the nodes it relays to, in order */
  spokes?: string[];
  /** hubs only: the task sentence in the hub's first message */
  task?: string;
}
export interface PEdge { from: string; to: string; label?: string }
export interface PipelineSpec {
  id: string;
  name?: string;
  description?: string;
  builtin?: boolean;
  nodes: PNode[];
  edges: PEdge[];
  output: string;
}

export interface Run {
  name: string;
  events: Ev[];
  /** index in `events` of every `message` event, in order */
  msgIdx: number[];
  /** number of messages = number of replay steps */
  M: number;
  start: Ev;
  end?: Ev;
  topology: Topology;
  /** the pipeline the run used. For logs written before the field existed this is a graph-only
   *  fallback for chain/orchestrator, and `hasPrompts` is false. */
  pipeline: PipelineSpec;
  hasPrompts: boolean;
  canary: string;
  userAddr: string;
  leaked: boolean;
  llmCalls: number;
  cached: number;
}
