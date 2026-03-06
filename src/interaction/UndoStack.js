export class UndoStack {
  constructor(state, onChange) {
    this.state = state;
    this.onChange = onChange;
    this.undoStack = [];
    this.redoStack = [];
  }

  push(action) {
    // action: { do(), undo(), label? }
    this.undoStack.push(action);
    this.redoStack = [];
    action.do();
    this.onChange();
  }

  undo() {
    const a = this.undoStack.pop();
    if (!a) return;
    a.undo();
    this.redoStack.push(a);
    this.onChange();
  }

  redo() {
    const a = this.redoStack.pop();
    if (!a) return;
    a.do();
    this.undoStack.push(a);
    this.onChange();
  }
}
