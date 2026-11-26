import { Migration } from '@mikro-orm/migrations';

export class Migration20261126121935 extends Migration {

  override async up(): Promise<void> {

    this.addSql(`alter table "assistant_runs" add column "planner" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "assistant_runs" drop column "planner";`);

  }

}
