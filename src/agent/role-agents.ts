import { BaseAgent, type BaseAgentContext, type BaseAgentResult, type BaseAgentRunInput } from "./base-agent.js";
import { StageError } from "./parse-envelope.js";

export class ExplorerAgent extends BaseAgent {
  constructor(context: BaseAgentContext) {
    if (context.profile.role !== "explorer") throw new StageError("ExplorerAgent requires an explorer profile", "explorer");
    super(context);
  }

  async run(input: BaseAgentRunInput): Promise<BaseAgentResult & { output: Extract<BaseAgentResult["output"], { kind: "fact" }> }> {
    const result = await this.executeAgent(input);
    if (result.output.kind !== "fact") {
      throw new StageError(`explorer returned kind="${result.output.kind}", expected "fact"`, "explorer");
    }
    return result as BaseAgentResult & { output: Extract<BaseAgentResult["output"], { kind: "fact" }> };
  }
}

export class EvaluatorAgent extends BaseAgent {
  constructor(context: BaseAgentContext) {
    if (context.profile.role !== "evaluator") throw new StageError("EvaluatorAgent requires an evaluator profile", "evaluator");
    super(context);
  }

  async run(input: BaseAgentRunInput): Promise<BaseAgentResult & { output: Extract<BaseAgentResult["output"], { kind: "verdict" }> }> {
    const result = await this.executeAgent(input);
    if (result.output.kind !== "verdict") {
      throw new StageError(`evaluator returned kind="${result.output.kind}", expected "verdict"`, "evaluator");
    }
    return result as BaseAgentResult & { output: Extract<BaseAgentResult["output"], { kind: "verdict" }> };
  }

  async runBroadcast(input: BaseAgentRunInput): Promise<BaseAgentResult & { output: Extract<BaseAgentResult["output"], { kind: "broadcast_assessment" }> }> {
    const result = await this.executeAgent({ ...input, outputContract: "broadcast_assessment" });
    if (result.output.kind !== "broadcast_assessment") {
      throw new StageError(
        `broadcast evaluator returned kind="${result.output.kind}", expected "broadcast_assessment"`,
        "evaluator",
      );
    }
    return result as BaseAgentResult & { output: Extract<BaseAgentResult["output"], { kind: "broadcast_assessment" }> };
  }
}

export class MetacogAgent extends BaseAgent {
  constructor(context: BaseAgentContext) {
    if (context.profile.role !== "metacog") throw new StageError("MetacogAgent requires a metacog profile", "metacog");
    super(context);
  }

  async run(input: BaseAgentRunInput): Promise<BaseAgentResult & {
    output: Extract<BaseAgentResult["output"], { kind: "hints" | "stop" }>;
  }> {
    const result = await this.executeAgent(input);
    if (result.output.kind !== "hints" && result.output.kind !== "stop") {
      throw new StageError(`metacog returned unexpected kind="${result.output.kind}"`, "metacog");
    }
    return result as BaseAgentResult & {
      output: Extract<BaseAgentResult["output"], { kind: "hints" | "stop" }>;
    };
  }
}
