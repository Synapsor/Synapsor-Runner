#!/usr/bin/env node
import process from "node:process";
import { runCliProcess } from "@synapsor/runner/cli";

process.env.SYNAPSOR_RUNNER_COMMAND_NAME = "synapsor-runner";
process.exitCode = await runCliProcess(process.argv.slice(2));
