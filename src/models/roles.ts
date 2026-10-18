import { z } from 'zod';

/** Model roles. The code asks for a role; a profile maps each role to an Ollama tag. */
export const RoleSchema = z.enum(['classify', 'guardPolicy', 'guardRisk', 'write', 'judge']);
export type Role = z.infer<typeof RoleSchema>;
