import { z } from 'zod';

/** Delivery channel ids; `Delivery.id` uses the same three. */
export const DeliveryIdSchema = z.enum(['markdown', 'email', 'slack']);
export type DeliveryId = z.infer<typeof DeliveryIdSchema>;
