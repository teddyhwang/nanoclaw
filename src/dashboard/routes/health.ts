import type { FastifyInstance } from 'fastify';
import { getHealthData } from '../health.js';

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/api/health', async (request) => {
    const query = request.query as Record<string, string>;
    const sinceParam = query.since;
    const untilParam = query.until;
    const daysParam = query.days;
    const opts: { since?: string; until?: string; days?: number } = sinceParam
      ? { since: sinceParam }
      : { days: Math.min(Math.max(parseInt(daysParam || '90', 10), 1), 5500) };
    if (untilParam) opts.until = untilParam;
    const data = getHealthData(opts);
    return data;
  });
}
