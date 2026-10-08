/**
 * Reconciles an inline suggestion with the text immediately after the cursor.
 * Handles auto-closed delimiters like ), ], }, quotes (" ' `).
 */
export function reconcileSuggestion(
  suggestion: string,
  textAfterCursor: string
): { insert: string; replaceLength: number } {
  if (!suggestion) {
    return { insert: "", replaceLength: 0 };
  }

  let finalSuggestion = suggestion;

  // Check if textAfterCursor starts with an auto-closed delimiter
  const autoCloseMatch = textAfterCursor.match(/^([)\]}'"`]+)/);
  if (autoCloseMatch) {
    const closedChar = autoCloseMatch[1][0];

    // If the suggestion omitted the auto-closed delimiter but continued with body/statement tokens,
    // insert the delimiter where it belongs so valid code is produced.
    if (!finalSuggestion.includes(closedChar)) {
      if (closedChar === ")") {
        // e.g. suggestion is "a: number, b: number {" -> insert ")" before "{" or "=>" or ";"
        const match = finalSuggestion.match(/(\s*(=>|\{|;))/);
        if (match && match.index !== undefined) {
          finalSuggestion =
            finalSuggestion.slice(0, match.index) +
            ")" +
            finalSuggestion.slice(match.index);
        }
      } else if (closedChar === "]" || closedChar === "}") {
        const match = finalSuggestion.match(/(\s*;)/);
        if (match && match.index !== undefined) {
          finalSuggestion =
            finalSuggestion.slice(0, match.index) +
            closedChar +
            finalSuggestion.slice(match.index);
        }
      } else if (['"', "'", "`"].includes(closedChar)) {
        const match = finalSuggestion.match(/(\s*([;,)}\]]))/);
        if (match && match.index !== undefined) {
          finalSuggestion =
            finalSuggestion.slice(0, match.index) +
            closedChar +
            finalSuggestion.slice(match.index);
        }
      }
    }
  }

  // Determine replaceLength in textAfterCursor:
  // If finalSuggestion spans over auto-closed characters that are currently after the cursor,
  // we must replace them so they aren't duplicated.
  let replaceLength = 0;

  if (textAfterCursor.length > 0) {
    const firstChar = textAfterCursor[0];
    if (
      [")", "]", "}", '"', "'", "`"].includes(firstChar) &&
      finalSuggestion.includes(firstChar)
    ) {
      let maxMatch = 0;
      for (let len = 1; len <= textAfterCursor.length; len++) {
        const prefix = textAfterCursor.slice(0, len);
        if (finalSuggestion.includes(prefix)) {
          maxMatch = len;
        } else {
          break;
        }
      }
      replaceLength = maxMatch;
    }
  }

  return {
    insert: finalSuggestion,
    replaceLength,
  };
}
