import { Event } from './http';
import { Principal, Company } from './model';
import { forbidden } from './errors';

/** The caller, as the authorizer described them. */
export function principalOf(event: Event): Principal {
  const a = event.requestContext.authorizer?.lambda;
  if (!a?.kind) throw forbidden('Not signed in');
  if (a.kind === 'app') {
    return { kind: 'app', id: `app:${a.id}`, companies: a.companies ? (String(a.companies).split(',') as Company[]) : undefined };
  }
  return { kind: 'user', id: `user:${a.id}`, email: a.email || undefined, name: a.name || undefined };
}
