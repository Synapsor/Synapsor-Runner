import {expect} from "vitest";
(globalThis as any)[Symbol.for("synapsor.qualification.current-test")] = () => expect.getState().currentTestName;
import "./trace-gates.cjs";
