/**
 * Decompose a goal into sequential steps.
 *
 * For now uses a simple rule-based approach:
 * 1. Parse the input
 * 2. Identify key actions
 * 3. Return ordered steps
 */
export async function createPlan(goal: string): Promise<{ steps: string[] }> {
  const lower = goal.toLowerCase();

  if (lower.includes("submit") || lower.includes("run")) {
    return {
      steps: [
        "Identify the software and input file",
        "Stage the input on the target runner",
        "Start the job and capture its ID",
        "Monitor the job until completion",
        "Fetch and parse the output",
      ],
    };
  }

  if (lower.includes("parse") || lower.includes("analyze")) {
    return {
      steps: [
        "Locate the output file",
        "Select the appropriate parser (gaussian, orca, xtb, cp2k)",
        "Run the parser via the Python bridge",
        "Validate the structured result",
        "Return the parsed data",
      ],
    };
  }

  if (lower.includes("status") || lower.includes("check")) {
    return {
      steps: [
        "Identify the target job or resource",
        "Query its current status",
        "Return the status report",
      ],
    };
  }

  return {
    steps: [
      "Analyze the request",
      "Identify the appropriate tool",
      "Execute the tool with the correct input",
      "Return the result",
    ],
  };
}
