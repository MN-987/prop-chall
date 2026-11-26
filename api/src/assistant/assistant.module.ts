import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module';
import { PropertiesModule } from '../properties/properties.module';
import { AssistantController } from './assistant.controller';
import { ASSISTANT_LANGUAGE_MODEL, AssistantService } from './assistant.service';

@Module({
  imports: [LeadsModule, PropertiesModule],
  controllers: [AssistantController],
  // Null: the service uses the real Anthropic model. Tests override this provider with a stand-in model.
  providers: [AssistantService, { provide: ASSISTANT_LANGUAGE_MODEL, useValue: null }],
  exports: [AssistantService],
})
export class AssistantModule {}
