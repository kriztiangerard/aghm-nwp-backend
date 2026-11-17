'use strict';
const { loadVendorCatalog } = require('../catalog-repository');
const { buildVendorPlansAssembled } = require('../orchestration');

exports.handler = async ({ vendor, input, requirements, sharedLedger, now }) => {
  const { catalog } = await loadVendorCatalog({ vendor: vendor.name, now });
  return { plans: buildVendorPlansAssembled({ vendor, input, requirements, catalog, sharedLedger }) };
};