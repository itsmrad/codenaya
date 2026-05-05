import { Tooltip, showTooltip, EditorView } from "@codemirror/view";
import { StateField, EditorState } from "@codemirror/state";
import { showQuickEditEffect, quickEditState } from "./quick-edit";
import { useChatStore } from "../../conversations/store/use-chat-store";

let editorView: EditorView | null = null;

const createTooltipForSelection = (
  state: EditorState,
  fileName: string
): readonly Tooltip[] => {
  const selection = state.selection.main;

  if (selection.empty) {
    return [];
  }

  const isQuickEditActive = state.field(quickEditState);
  if (isQuickEditActive) {
    return [];
  }

  return [
    {
      pos: selection.to,
      above: false,
      strictSide: false,
      create() {
        const dom = document.createElement("div");
        dom.className =
          "bg-popover text-popover-foreground z-50 rounded-sm border border-input p-1 shadow-md flex items-center gap-2 text-sm";

        const addToChatButton = document.createElement("button");
        addToChatButton.textContent = "Add to Chat";
        addToChatButton.className =
            "font-sans p-1 px-2 hover:bg-foreground/10 rounded-sm";
        addToChatButton.onclick = () => {
          if (editorView) {
            const startLine = editorView.state.doc.lineAt(selection.from).number;
            const endLine = editorView.state.doc.lineAt(selection.to).number;
            const selectedText = editorView.state.doc.sliceString(selection.from, selection.to);
            useChatStore.getState().addContext({
              fileName,
              startLine,
              endLine,
              content: selectedText
            });
            editorView.dispatch({
              selection: { anchor: selection.from },
            });
          }
        };
        
        const quickEditButton = document.createElement("button");
        quickEditButton.className =
          "font-sans p-1 px-2 hover:bg-foreground/10 rounded-sm flex items-center gap-1";

        const quickEditButtonText = document.createElement("span");
        quickEditButtonText.textContent = "Quick Edit";

        const quickEditButtonShortcut = document.createElement("span");
        quickEditButtonShortcut.textContent = "⌘K";
        quickEditButtonShortcut.className = "text-sm opacity-60";

        quickEditButton.appendChild(quickEditButtonText);
        quickEditButton.appendChild(quickEditButtonShortcut);

        quickEditButton.onclick = () => {
          if (editorView) {
            editorView.dispatch({
              effects: showQuickEditEffect.of(true),
            });
          }
        };

        dom.appendChild(addToChatButton);
        dom.appendChild(quickEditButton);

        return { dom };
      },
    }
  ]
}

const selectionTooltipField = (fileName: string) => StateField.define<readonly Tooltip[]>({
  create(state) {
    return createTooltipForSelection(state, fileName);
  },

  update(tooltips, transaction) {
    if (transaction.docChanged || transaction.selection) {
      return createTooltipForSelection(transaction.state, fileName);
    }
    for (const effect of transaction.effects) {
      if (effect.is(showQuickEditEffect)) {
        return createTooltipForSelection(transaction.state, fileName);
      }
    }
    return tooltips;
  },

  provide: (field) => showTooltip.computeN(
    [field],
    (state) => state.field(field),
  ),
});

const captureViewExtension = EditorView.updateListener.of((update) => {
  editorView = update.view;
});

export const selectionTooltip = (fileName: string) => [
  selectionTooltipField(fileName),
  captureViewExtension,
];