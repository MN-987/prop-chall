import { Migration } from '@mikro-orm/migrations';

export class Migration20261126111145 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "assistant_runs" ("id" uuid not null, "agency_id" uuid not null, "lead_id" uuid not null, "message_id" uuid not null, "message_ids" jsonb not null, "trigger" text check ("trigger" in ('manual', 'whatsapp')) not null, "status" text check ("status" in ('running', 'completed', 'failed')) not null, "error" text null, "requirements" jsonb not null, "recommendations" jsonb not null, "summary" text not null default '', "price_checks" jsonb not null default '[]', "trace" jsonb not null default '[]', "usage" jsonb null, "cost_usd" numeric(12,4) not null default '0', "model" varchar(255) not null, "created_at" timestamptz not null, "finished_at" timestamptz null, constraint "assistant_runs_pkey" primary key ("id"));`);
    this.addSql(`create index "assistant_runs_lead_id_created_at_index" on "assistant_runs" ("lead_id", "created_at");`);
    // Written by hand (MikroORM does not generate partial indexes): the database itself refuses a second running
    // run for the same lead, even when two start at the same moment.
    this.addSql(`create unique index "assistant_runs_one_running_per_lead" on "assistant_runs" ("lead_id") where "status" = 'running';`);

    this.addSql(`create table "assistant_actions" ("id" uuid not null, "run_id" uuid not null, "position" int not null, "type" text check ("type" in ('create_follow_up_task', 'assign_lead')) not null, "status" text check ("status" in ('pending_approval', 'approved', 'rejected')) not null default 'pending_approval', "payload" jsonb not null, "task_id" uuid null, "decided_by_id" uuid null, "decided_at" timestamptz null, "created_at" timestamptz not null, constraint "assistant_actions_pkey" primary key ("id"));`);
    this.addSql(`create index "assistant_actions_run_id_position_index" on "assistant_actions" ("run_id", "position");`);

    this.addSql(`alter table "assistant_runs" add constraint "assistant_runs_agency_id_foreign" foreign key ("agency_id") references "agencies" ("id") on update cascade;`);
    this.addSql(`alter table "assistant_runs" add constraint "assistant_runs_lead_id_foreign" foreign key ("lead_id") references "leads" ("id") on update cascade;`);
    this.addSql(`alter table "assistant_runs" add constraint "assistant_runs_message_id_foreign" foreign key ("message_id") references "messages" ("id") on update cascade;`);

    this.addSql(`alter table "assistant_actions" add constraint "assistant_actions_run_id_foreign" foreign key ("run_id") references "assistant_runs" ("id") on update cascade;`);
    this.addSql(`alter table "assistant_actions" add constraint "assistant_actions_task_id_foreign" foreign key ("task_id") references "tasks" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "assistant_actions" add constraint "assistant_actions_decided_by_id_foreign" foreign key ("decided_by_id") references "agents" ("id") on update cascade on delete set null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "assistant_actions" drop constraint "assistant_actions_run_id_foreign";`);

    this.addSql(`drop table if exists "assistant_runs" cascade;`);

    this.addSql(`drop table if exists "assistant_actions" cascade;`);
  }

}
