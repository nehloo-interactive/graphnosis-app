import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEvolveAutonomyLevel,
  capPraxisByEvolve,
  DEFAULT_EVOLVE_AUTONOMY_LEVEL,
} from '@graphnosis-app/core/settings';

describe('Evolve autonomy', () => {
  it('defaults to preview-first', () => {
    assert.equal(resolveEvolveAutonomyLevel(null), DEFAULT_EVOLVE_AUTONOMY_LEVEL);
    assert.equal(resolveEvolveAutonomyLevel({}), 'preview-first');
  });

  it('caps Praxis by the stricter (lower) Evolve ceiling', () => {
    assert.equal(capPraxisByEvolve('auto-accept', 'preview-first'), 'preview-first');
    assert.equal(capPraxisByEvolve('auto-accept', 'notify'), 'notify');
    assert.equal(capPraxisByEvolve('notify', 'auto-accept'), 'notify');
    assert.equal(capPraxisByEvolve('preview-first', 'auto-accept'), 'preview-first');
  });
});
