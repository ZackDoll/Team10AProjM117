/** One JSONL line of a run log. Fields vary by `event`; see docs/LOG_SCHEMA.md. */
export type Ev = { event: string; [key: string]: any };

export type Topology = 'chain' | 'orchestrator';

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
  canary: string;
  userAddr: string;
  leaked: boolean;
  llmCalls: number;
  cached: number;
}
