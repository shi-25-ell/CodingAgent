import { createNodeLocalExecutionPorts } from "../adapters/node-local-execution-adapters.js";
import {
  type CodingToolHost,
  type CodingToolHostOptions,
  createCodingToolHost,
} from "../tools/coding-tool-host.js";

export function createLocalCodingToolHost(options: CodingToolHostOptions): CodingToolHost {
  return createCodingToolHost(options, createNodeLocalExecutionPorts());
}
