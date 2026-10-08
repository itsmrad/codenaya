import ts from "typescript";

const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * The first syntax error in a script file the agent wrote, as `line:col message`,
 * or null when it parses (or isn't a script). A broken file otherwise surfaces
 * only as a Vite error overlay in the preview (#190); reporting it from the
 * write tool lets the agent fix it in the same run.
 */
export const syntaxError = (fileName: string, content: string): string | null => {
  if (!SCRIPT_FILE.test(fileName)) return null;

  const { diagnostics = [] } = ts.transpileModule(content, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  });
  const error = diagnostics.find(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (!error) return null;

  const message = ts.flattenDiagnosticMessageText(error.messageText, " ");
  if (!error.file || error.start === undefined) return message;
  const { line, character } = error.file.getLineAndCharacterOfPosition(error.start);
  return `${line + 1}:${character + 1} ${message}`;
};

/** The note a write tool appends when files it wrote don't parse. */
export const syntaxErrorNote = (files: { name: string; content: string }[]) => {
  const errors = files.flatMap((file) => {
    const error = syntaxError(file.name, file.content);
    return error ? [`${file.name} ${error}`] : [];
  });
  return errors.length > 0
    ? `\nSyntax errors (the content was saved; fix it with updateFile before finishing): ${errors.join("; ")}`
    : "";
};
