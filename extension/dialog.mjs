// SPDX-License-Identifier: MPL-2.0
// A modal dialog can prevent CDP/input promises from settling. Stop the operation
// at that boundary; never run its remaining input steps or choose a dialog answer.
export function untilDialog(session, invoke) {
  if (session.dialog)
    return Promise.reject(
      Object.assign(new Error("Handle the pending dialog first"), {
        code: "dialog_pending",
      }),
    );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      chrome.debugger.onEvent?.removeListener?.(listener);
      error ? reject(error) : resolve(value);
    };
    const listener = (source, method) => {
      if (
        source.tabId === session.tabId &&
        !source.sessionId &&
        method === "Page.javascriptDialogOpening"
      )
        finish(
          Object.assign(
            new Error("Operation interrupted by a JavaScript dialog"),
            { code: "dialog_opened" },
          ),
        );
    };
    chrome.debugger.onEvent?.addListener(listener);
    try {
      Promise.resolve(invoke()).then(
        (value) => finish(null, value),
        (error) => finish(error),
      );
    } catch (error) {
      finish(error);
    }
  });
}
