const key = (projectId: string, messageId: string) =>
  `codenaya:noteProposalDismissed:${projectId}:${messageId}`;

/** Keep each dismissed suggestion hidden when revisiting this project. */
export function isNoteProposalDismissed(projectId: string, messageId: string): boolean {
  try {
    return localStorage.getItem(key(projectId, messageId)) === "1";
  } catch {
    return false;
  }
}

export function dismissNoteProposal(projectId: string, messageId: string): void {
  try {
    localStorage.setItem(key(projectId, messageId), "1");
  } catch {
    // Best-effort: the sidebar still dismisses it for this session.
  }
}
