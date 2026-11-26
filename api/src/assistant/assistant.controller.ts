import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthAgent, CurrentAgent } from '../auth/decorators';
import { StartRunDto } from './assistant.dto';
import { AssistantService } from './assistant.service';

/** TASK.md's API contract. Another agency's lead, run or action is a 404. */
@Controller('leads/:leadId/assistant/runs')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post()
  start(@CurrentAgent() agent: AuthAgent, @Param('leadId', ParseUUIDPipe) leadId: string, @Body() dto: StartRunDto) {
    return this.assistant.startManualRun(agent, leadId, dto);
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
