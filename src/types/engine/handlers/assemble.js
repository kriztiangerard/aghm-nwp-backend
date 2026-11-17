'use strict';
const { finishEngineResult } = require('../orchestration');
const { finalizeEngineResult } = require('../steps/assemble');

exports.handler = async ({ input, requirements, vendors, ctx, vendorResults }) => {
  const plans = vendorResults.flatMap((result) => result.plans);
  const result = finishEngineResult({ input, requirements, vendors, plans, sharedCtx: ctx });
  return finalizeEngineResult(result, new Date().toISOString());
};