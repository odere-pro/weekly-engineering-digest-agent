import { modelsForRole, type ModelProfile } from '../../../config/profiles';
import { DigestError } from '../../../shared/errors';
import type { Role } from '../../roles';

/** The model tag for a call: the explicit one, else the profile's first for `role`. */
export function resolveModel(profile: ModelProfile, role: Role, explicit?: string): string {
  const model = explicit ?? modelsForRole(profile, role)[0];
  if (!model)
    throw new DigestError(`No model is configured for role ${role} in profile ${profile.name}`);
  return model;
}
