// Prints the model tags the Linux container needs, one per line. docker/validate.sh compares this
// with docker/pull-models.sh so the two lists cannot drift apart. Run through tsx.
import { NON_MAC_FALLBACK, requiredModels } from '../src/config/profiles.js';

const linux = { name: 'quality', ...NON_MAC_FALLBACK };
process.stdout.write(`${requiredModels(linux).join('\n')}\n`);
