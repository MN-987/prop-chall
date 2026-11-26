import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthAgent, CurrentAgent } from '../auth/decorators';
import { StartRunDto } from './assistant.dto';
import { AssistantService } from './assistant.service';

/** TASK.md's API contract. Another agency's lead, run or action is a 404. */
@Controller('leads/:leadId/assistant/runs')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  /** Waits for the result (201). With `?async=true` it answers 202 straight away and the run continues in the background. */
  @Post()
  async start(
    @CurrentAgent() agent: AuthAgent,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: StartRunDto,
    @Query('async') asyncFlag: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const background = asyncFlag === 'true';
    const run = await this.assistant.startManualRun(agent, leadId, dto, background);
    if (background) response.status(202);
    return run;
  }

  @Get()
  list(@CurrentAgent() agent: AuthAgent, @Param('leadId', ParseUUIDPipe) leadId: string) {
    return this.assistant.listRuns(agent.agencyId, leadId);
  }

  @Get(':runId')
  get(
    @CurrentAgent() agent: AuthAgent,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.assistant.getRun(agent.agencyId, leadId, runId);
  }

  @Post(':runId/actions/:actionId/approve')
  @HttpCode(200)
  approve(
    @CurrentAgent() agent: AuthAgent,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
  ) {
    return this.assistant.approve(agent, leadId, runId, actionId);
  }

  @Post(':runId/actions/:actionId/reject')
  @HttpCode(200)
  reject(
    @CurrentAgent() agent: AuthAgent,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
  ) {
    return this.assistant.reject(agent, leadId, runId, actionId);
  }
}
