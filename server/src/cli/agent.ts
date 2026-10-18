#!/usr/bin/env bun
import { createAgentProgram, runOperatorProgram } from "./operator-program";
export { createAgentProgram } from "./operator-program";
if (import.meta.main) await runOperatorProgram(createAgentProgram());
