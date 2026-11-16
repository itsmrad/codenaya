export const missingEnvVarsMessage = (count: number): string =>
  `Detected ${count} missing environment ${count === 1 ? "variable" : "variables"} in the imported project.`;
