import type { ToolSet } from 'ai';
import type { ConversationMessage } from '../agent';
import type { buildTools, TraceEntry } from '../tools';

/**
 * Strategy pattern for "who chooses the tools". Everything else about a run stays the same: the same traced
 * tools, the same code checks on the answer, and Claude writes the ranking, reasons, summary and follow-up.
 *
 * - `claude`: Claude chooses and calls the tools itself, in its agent loop.
 * - `jev`: TypeSafe's Jev chooses the tool calls in one request; code runs them; Claude then gets the results and
 *   has no tools at all. A side effect: the model that writes the answer never decides what to query.
 *
 * Adding another planner (for example an OpenAI model) means one more class implementing `ToolPlanner`.
 */
export const TOOL_PLANNERS = ['claude', 'jev'] as const;
export type ToolPlannerName = (typeof TOOL_PLANNERS)[number];

export type AgentTools = ReturnType<typeof buildTools>;

export interface PlanningInput {
  messages: ConversationMessage[];
  newMessageIds: string[];
  /** The agency's listing areas: the only values `search_listings` accepts. */
  areas: string[];
  /** The traced tools for this run. A planner that runs tools must run them through these. */
  tools: AgentTools;
  /** The run's trace, which the traced tools append to. Read only. */
  trace: readonly TraceEntry[];
}

/** What the planner decided, kept on the run so the UI and the evals can see it. */
export interface PlannerRecord {
  name: ToolPlannerName;
  /** For planners that decide outside the model loop: the raw judgments, by question. */
  decisions?: Record<string, unknown>;
  costUsd: number;
}

export interface PreparedTools {
  /** Tools the writing model may still call itself; undefined when the planner already ran everything. */
  toolsForModel: ToolSet | undefined;
  /** Results of the tool calls the planner ran, shown to the writing model as data. */
  preloadedResults: TraceEntry[];
  record: PlannerRecord;
}

export interface ToolPlanner {
  readonly name: ToolPlannerName;
  prepare(input: PlanningInput): Promise<PreparedTools>;
}
