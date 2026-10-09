import { Router, type RequestHandler } from 'express';
import type { Override, OverrideStore } from '../core/types.js';
import { HttpError } from './errors.js';
import type { components } from './generated/openapi.js';

type ApiOverride = components['schemas']['Override'];
type CreateOverrideRequest = components['schemas']['CreateOverrideRequest'];

export interface AdminDependencies {
  overrides: OverrideStore;
  clock: () => number;
  ids: () => string;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function toApiOverride(o: Override): ApiOverride {
  return {
    id: o.id,
    reason: o.reason,
    criteria: o.criteria,
    effect: o.effect,
    ...(o.startsAt !== undefined ? { startsAt: iso(o.startsAt) } : {}),
    expiresAt: iso(o.expiresAt),
    createdAt: iso(o.createdAt),
  };
}

const wrap =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

/**
 * `/admin/overrides` routes. Request shapes are enforced by the OpenAPI validator before
 * these handlers run; only semantic checks (expiry in the future) live here.
 */
export function adminRouter({ overrides, clock, ids }: AdminDependencies): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (_req, res) => {
      const all = await overrides.list();
      res.json({ overrides: all.map(toApiOverride) });
    }),
  );

  router.post(
    '/',
    wrap(async (req, res) => {
      const body = req.body as CreateOverrideRequest;
      const now = clock();

      const expiresAt =
        body.ttlSeconds !== undefined
          ? now + body.ttlSeconds * 1000
          : Date.parse(body.expiresAt as string);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        throw new HttpError(400, 'expiresAt must be in the future', [
          {
            path: body.ttlSeconds !== undefined ? '/body/ttlSeconds' : '/body/expiresAt',
            message: 'must be in the future',
          },
        ]);
      }
      const startsAt = body.startsAt !== undefined ? Date.parse(body.startsAt) : undefined;
      if (startsAt !== undefined && !Number.isFinite(startsAt)) {
        throw new HttpError(400, 'startsAt must be a valid date-time', [
          { path: '/body/startsAt', message: 'invalid date' },
        ]);
      }

      const override: Override = {
        id: ids(),
        reason: body.reason,
        criteria: body.criteria ?? {},
        effect: body.effect,
        ...(startsAt !== undefined ? { startsAt } : {}),
        expiresAt,
        createdAt: now,
      };

      try {
        await overrides.put(override);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      res.status(201).json(toApiOverride(override));
    }),
  );

  router.delete(
    '/:id',
    wrap(async (req, res) => {
      const removed = await overrides.remove(String(req.params.id));
      if (!removed) throw new HttpError(404, `No override with id "${String(req.params.id)}"`);
      res.status(204).end();
    }),
  );

  return router;
}
