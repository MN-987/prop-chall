import { PlanningInput, PreparedTools, ToolPlanner } from './tool-planner';

/** Claude chooses the tools itself: hand the traced tools to the agent loop and run nothing up front. */
export class ClaudeToolPlanner implements ToolPlanner {
  readonly name = 'claude' as const;

  async prepare(input: PlanningInput): Promise<PreparedTools> {
    return { toolsForModel: input.tools, preloadedResults: [], record: { name: this.name, costUsd: 0 } };
  }
}
