#!/usr/bin/env bun
import { createServerProgram, runOperatorProgram } from "./operator-program";
export { createServerProgram } from "./operator-program";
if (import.meta.main) await runOperatorProgram(createServerProgram());
