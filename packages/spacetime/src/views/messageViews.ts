import { t } from 'spacetimedb/server';
import spacetimedb, { message } from '../schema';
import { incidentScoped } from './scope';

/** Message content is untrusted user input: render as plain text only. */
export const my_messages = spacetimedb.view({ name: 'my_messages', public: true }, t.array(message.rowType), ctx =>
  incidentScoped(ctx.db, ctx.sender, 'VIEW_MESSAGES', id => ctx.db.message.incidentId.filter(id))
);
