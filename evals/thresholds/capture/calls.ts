// The four model calls a capture makes for one subject. Each returns the raw answer or throws;
// runner.ts turns a throw into a failed record.
import { classifyStep } from '../../../src/classify/classify';
import type { Item } from '../../../src/domain/schemas';
import type { InputGuard, OutputGuard } from '../../../src/guards/Guard';
import type { ModelProvider } from '../../../src/models/ModelProvider';
import { DigestError } from '../../../src/shared/errors';
import type { Logger } from '../../../src/shared/telemetry';
import type { Classified, InputGuardRecord } from './schemas';
import type { DraftSubject } from './subjects';

/** What the calls need: the model, the focus areas and the three guards under test. */
export interface ItemCallDeps {
  model: ModelProvider;
  focusAreas: readonly string[];
  clefPolicy: InputGuard;
  graniteRisk: InputGuard;
  clefRubric: OutputGuard;
  logger: Logger;
}

export async function classifyItem(item: Item, deps: ItemCallDeps): Promise<Classified> {
  const [scored] = await classifyStep([item], {
    model: deps.model,
    focusAreas: deps.focusAreas,
    logger: deps.logger,
  });
  if (!scored) throw new DigestError(`classify returned nothing for item ${item.id}`);
  const { relevance, area, areaConfidence, hype, minorRelease } = scored.classification;
  return { relevance, area, areaConfidence, hype, minorRelease };
}

export async function policyProbability(
  item: Item,
  deps: ItemCallDeps,
): Promise<{ probability: number }> {
  const verdict = await deps.clefPolicy.checkItem(item);
  if (verdict.probability === undefined)
    throw new DigestError(`clefPolicy gave no probability for item ${item.id}`);
  return { probability: verdict.probability };
}

export async function graniteVerdict(
  item: Item,
  deps: ItemCallDeps,
): Promise<InputGuardRecord['graniteRisk']> {
  const { flagged, reason } = await deps.graniteRisk.checkItem(item);
  return reason === undefined ? { flagged } : { flagged, reason };
}

export async function rubricProbability(
  subject: DraftSubject,
  deps: ItemCallDeps,
): Promise<{ probability: number }> {
  const verdict = await deps.clefRubric.checkDraft(subject.value, subject.sources);
  if (verdict.probability === undefined)
    throw new DigestError(
      `clefRubric gave no probability for ${subject.caseId} (${subject.draft})`,
    );
  return { probability: verdict.probability };
}
