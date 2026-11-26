/**
 * Runs the agent once on a seeded lead and prints what it decided. Calls the real model (costs a few cents).
 *   pnpm -C api exec tsx src/assistant/smoke.ts Karim
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { Lead, Message } from '../entities';
import { buildOrmConfig } from '../mikro-orm.config';
import { PropertiesService } from '../properties/properties.service';
import { runAgent } from './agent';
import { loadAgencyAreas } from './tools';

async function main() {
  const name = process.argv[2] ?? 'Karim';
  const orm = await MikroORM.init(buildOrmConfig());
  try {
    const em = orm.em.fork();
    const lead = await em.findOneOrFail(Lead, { name: { $ilike: `${name}%` } }, { populate: ['assignedAgent', 'agency'] });
    const messages = await em.find(Message, { lead }, { orderBy: { sentAt: 'asc', id: 'asc' } });
    const latestInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
    const result = await runAgent({
      leadName: lead.name,
      messages,
      newMessageIds: latestInbound ? [latestInbound.id] : [],
      timeZone: lead.assignedAgent?.timezone ?? 'Asia/Dubai',
      tools: {
        agencyId: lead.agency.id,
        areas: await loadAgencyAreas(em, lead.agency.id),
        em,
        properties: new PropertiesService(em),
      },
    });
    const { trace, ...rest } = result;
    console.log(JSON.stringify(rest, null, 2));
    console.log('\nTRACE');
    for (const t of trace) {
      const out = t.error ?? JSON.stringify(t.output).slice(0, 160);
      console.log(`- ${t.tool} ${JSON.stringify(t.input)} (${t.durationMs} ms) -> ${out}`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
