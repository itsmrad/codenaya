import { SubagentRole } from "../types";
import { ISubagent } from "./base";
import { ExplorerSubagent } from "./explorer";
import { ArchitectSubagent } from "./architect";
import { FrontendEngineerSubagent } from "./frontend-engineer";
import { BackendEngineerSubagent } from "./backend-engineer";
import { DatabaseEngineerSubagent } from "./database-engineer";
import { DebuggerSubagent } from "./debugger";
import { TesterSubagent } from "./tester";
import { SecurityReviewerSubagent } from "./security-reviewer";
import { PerformanceReviewerSubagent } from "./performance-reviewer";
import { UxReviewerSubagent } from "./ux-reviewer";
import { CodeReviewerSubagent, ReviewerSubagent } from "./reviewer";
import { ImplementerSubagent } from "./implementer";

export class SubagentRegistry {
  private agents: Map<SubagentRole, ISubagent>;

  constructor(customAgents?: Map<SubagentRole, ISubagent>) {
    this.agents =
      customAgents ??
      new Map<SubagentRole, ISubagent>([
        ["explorer", new ExplorerSubagent()],
        ["architect", new ArchitectSubagent()],
        ["frontend-engineer", new FrontendEngineerSubagent()],
        ["backend-engineer", new BackendEngineerSubagent()],
        ["database-engineer", new DatabaseEngineerSubagent()],
        ["debugger", new DebuggerSubagent()],
        ["tester", new TesterSubagent()],
        ["security-reviewer", new SecurityReviewerSubagent()],
        ["performance-reviewer", new PerformanceReviewerSubagent()],
        ["ux-reviewer", new UxReviewerSubagent()],
        ["code-reviewer", new CodeReviewerSubagent()],
        // Aliases
        ["implementer", new ImplementerSubagent()],
        ["reviewer", new ReviewerSubagent()],
      ]);
  }

  public getAgent(role: SubagentRole): ISubagent | undefined {
    return this.agents.get(role);
  }

  public registerAgent(role: SubagentRole, agent: ISubagent): void {
    this.agents.set(role, agent);
  }

  public getAllAgents(): Map<SubagentRole, ISubagent> {
    return new Map(this.agents);
  }
}
