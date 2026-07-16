import type { OagenConfig } from '@workos/oagen';
import { workosEmittersPlugin } from './src/plugin.js';

// Config for local emitter development. The canonical consumer config lives
// in openapi-spec/oagen.config.ts; this one mirrors its resolution policy
// (operation hints, mount rules, transforms) by importing it from the sibling
// checkout so local `npm run sdk:generate:*` output matches production
// naming and mounting. Requires ../openapi-spec to be checked out.
import {
  modelHints,
  mountRules,
  nestjsOperationIdTransform,
  operationHints,
  schemaNameTransform,
  transformSpec,
} from '../openapi-spec/src/policy/index.js';

const config: OagenConfig = {
  ...workosEmittersPlugin,
  docUrl: 'https://workos.com/docs',
  operationIdTransform: nestjsOperationIdTransform,
  schemaNameTransform,
  operationHints,
  mountRules,
  modelHints,
  transformSpec,
};
export default config;
